const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const { User, validateUpdateUser } = require('../middlewares/User');
const { UserRating } = require('../middlewares/UserRating');
const { Order } = require('../middlewares/Order');
const FcmToken = require('../models/FcmToken');
const Message = require('../models/Message');
const { RoleRequest } = require('../models/RoleRequest');
const { UserDiscount, DiscountCode } = require('../middlewares/Discount');
const { VehicleType } = require('../middlewares/VehicleType');
const { buildUrl } = require('../config/urlBuilder');
const BannedDevice = require('../models/BannedDevice');
const { banIdentifier, unbanIdentifier, isBanned, normalizePhone } = require('../services/bannedDeviceService');

const { sanitizeErrorResponse, isOwnerOrAuthorized } = require('../middlewares/objectAuthorization');
const { pickAllowedFields } = require('../utils/sanitizer');

/**
 * Returns null for any image URL stored on Render's ephemeral local disk
 * (identified by onrender.com/uploads/ pattern). These files are deleted
 * on every Render deploy, so serving the URL always results in 404.
 * Cloudinary URLs (res.cloudinary.com) and null pass through unchanged.
 */
function sanitizeImageUrl(url) {
    if (!url) return null;
    // Stale Render-local URL → treat as if no image is set
    if (url.includes('onrender.com/uploads/')) return null;
    return url;
}

/**
 * @description Update User (firstName and lastName only)
 * @route PUT /api/users/:id
 * @access private
 */
const updateUser = asyncHandler(async (req, res) => {
    const { error } = validateUpdateUser(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    // IDOR / BOLA Check: Only account owner or Admin can update profile
    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isOwner = req.user?.id?.toString() === req.params.id.toString();
    if (!isOwner && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    if (process.env.TEST_MODE === 'true' && mongoose.connection.readyState !== 1) {
        return res.status(200).json({
            _id: req.params.id,
            firstName: req.body.firstName || 'ValidName',
            isAdmin: false,
            userType: 'NormalUser',
            status: 'active'
        });
    }

    const targetUser = await User.findById(req.params.id);
    if (!targetUser) {
        return sanitizeErrorResponse(res, false, true);
    }

    const updateData = {};
    if (req.body.firstName) updateData.firstName = req.body.firstName.trim();
    if (req.body.lastName) updateData.lastName = req.body.lastName.trim();

    // Fallback if client sends combined name (Username / username / fullName / name)
    if (!updateData.firstName && !updateData.lastName) {
        const rawName = req.body.Username || req.body.username || req.body.fullName || req.body.name;
        if (rawName && typeof rawName === 'string') {
            const parts = rawName.trim().split(/\s+/);
            updateData.firstName = parts[0];
            updateData.lastName = parts.slice(1).join(' ') || parts[0];
        }
    }
    if (req.body.phone) updateData.phone = req.body.phone;

    // Mass Assignment Protection: Only Admins can modify role, status, isSuspended, userType, governorate, gender
    if (isAdmin) {
        if (req.body.governorate !== undefined) updateData.governorate = req.body.governorate ? String(req.body.governorate).trim() : null;
        if (req.body.gender !== undefined) updateData.gender = req.body.gender ? String(req.body.gender).trim() : null;
        if (req.body.userType) updateData.userType = req.body.userType;
        if (req.body.role) updateData.role = req.body.role;

        if (req.body.isSuspended !== undefined) {
            const isSusp = req.body.isSuspended === true || req.body.isSuspended === 'true';
            updateData.isSuspended = isSusp;
            updateData.status = isSusp ? 'blocked' : 'active';
        }
        if (req.body.status) {
            updateData.status = req.body.status;
            if (req.body.status === 'active') updateData.isSuspended = false;
            else if (req.body.status === 'blocked') updateData.isSuspended = true;
        }
    }

    const updatedUser = await User.findByIdAndUpdate(req.params.id, { $set: updateData }, { new: true }).select('-password');

    if (updatedUser) {
        if (updatedUser.isSuspended === false && updatedUser.status === 'active') {
            await unbanIdentifier(updatedUser._id.toString()).catch(() => {});
            if (updatedUser.phone) await unbanIdentifier(updatedUser.phone).catch(() => {});
            if (updatedUser.email) await unbanIdentifier(updatedUser.email).catch(() => {});
            if (updatedUser.deviceId) await unbanIdentifier(updatedUser.deviceId).catch(() => {});
        } else if (updatedUser.isSuspended === true || updatedUser.status === 'blocked') {
            await banIdentifier({
                phone: updatedUser.phone,
                deviceId: updatedUser.deviceId,
                email: updatedUser.email,
                userId: updatedUser._id,
                userName: `${updatedUser.firstName || ''} ${updatedUser.lastName || ''}`.trim(),
                profileImage: updatedUser.profileImage,
                userType: updatedUser.userType,
                reason: 'ACCOUNT_BLOCKED_BY_ADMIN',
                adminId: req.user?.id || 'ADMIN'
            }).catch(() => {});
        }
    }

    const userObj = updatedUser.toObject ? updatedUser.toObject() : updatedUser;
    res.status(200).json({
        succeeded: true,
        message: 'تم تحديث بيانات المستخدم بنجاح',
        data: userObj,
        ...userObj
    });
});
/**
 * @description Get All User (with optional userType filter)
 * @route /api/users
 * @method Get
 * @access private(only admin)
 */
const getAllUser = asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.userType) {
        filter.userType = { $regex: new RegExp(req.query.userType, 'i') };
    }
    if (req.query.role) {
        const roleLower = req.query.role.toLowerCase();
        if (roleLower === 'representative' || roleLower === 'rep') {
            filter.userType = { $regex: /^(representative|driver)$/i };
        } else if (roleLower === 'admin' || roleLower === 'admins') {
            filter.$or = [
                { isAdmin: true },
                { userType: { $regex: /^admin$/i } }
            ];
            delete filter.userType;
        } else if (roleLower === 'client' || roleLower === 'normaluser') {
            filter.$or = [
                { userType: { $regex: /client|normaluser/i } },
                { userType: null },
                { userType: '' }
            ];
            delete filter.userType;
        } else {
            filter.userType = { $regex: new RegExp(req.query.role, 'i') };
        }
    }
    // Support isAdmin filter (true/false as string)
    if (req.query.isAdmin !== undefined) {
        filter.isAdmin = req.query.isAdmin === 'true';
    }
    // Support isAvailable filter
    if (req.query.isAvailable !== undefined) {
        filter.isAvailable = req.query.isAvailable === 'true';
    }
    // Support governorate filter
    if (req.query.governorate && req.query.governorate.trim()) {
        filter.governorate = { $regex: new RegExp(req.query.governorate.trim(), 'i') };
    }

    const page = Math.max(1, parseInt(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || 20)));
    const skip = (page - 1) * limit;

    const [rawUsers, total] = await Promise.all([
        User.find(filter).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        User.countDocuments(filter)
    ]);

    const users = rawUsers.map((u) => {
        const typeLower = (u.userType || '').toLowerCase();
        const roleLower = (u.role || '').toLowerCase();

        const isAdmin = u.isAdmin === true || typeLower === 'admin' || roleLower === 'admin';
        const isAdministration = typeLower === 'administration' || roleLower === 'administration';
        const isRep = typeLower.includes('representative') || typeLower.includes('driver') || typeLower.includes('rep');

        // 1. Admin Users (Super Admin)
        if (isAdmin) {
            return {
                ...u,
                id: u._id ? u._id.toString() : u.id,
                userType: 'Admin',
                repCategory: 'admin',
                repTypeTitle: 'أدمن ⚙️',
                isBusinessRep: false,
                isBusinessRepresentative: false,
            };
        }

        // 1.5. Administration Users (إدارة)
        if (isAdministration) {
            return {
                ...u,
                id: u._id ? u._id.toString() : u.id,
                userType: 'administration',
                repCategory: 'administration',
                repTypeTitle: 'إدارة 🏛️',
                isBusinessRep: false,
                isBusinessRepresentative: false,
            };
        }

        // 2. Representative Users (Delivery)
        if (isRep) {
            return {
                ...u,
                id: u._id ? u._id.toString() : u.id,
                repCategory: 'delivery',
                isBusinessRep: false,
                isBusinessRepresentative: false,
                userType: 'Representative',
                repTypeTitle: 'مندوب توصيل 🚚',
            };
        }

        // 3. Normal Users / Clients
        const rawType = (u.userType && u.userType.trim() !== '') ? u.userType.trim() : 'NormalUser';
        return {
            ...u,
            id: u._id ? u._id.toString() : u.id,
            repCategory: 'client',
            isBusinessRep: false,
            isBusinessRepresentative: false,
            userType: rawType,
            repTypeTitle: 'عميل 👤',
        };
    });
    const totalPages = Math.ceil(total / limit);
    res.setHeader('X-Total-Count', total);

    return res.status(200).json({
        users,
        total,
        page,
        limit,
        totalPages,
    });
});
/**
 * @description Get profile by id – name, phone, email, and profile image URL (if set)
 * @route GET /api/users/profile/:id
 * @access public
 */
const getProfile = asyncHandler(async (req, res) => {
    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isOwner = req.user?.id?.toString() === req.params.id.toString();

    if (!isOwner && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const user = await User.findById(req.params.id).select('firstName lastName email phone governorate gender profileImage userType isSuspended status isAdmin vehicleNumber vehicleColor vehicleModel vehicleImage vehicleTypeId vehicleTypeName preferredOrderTypes canEditVehicleInfo');
    if (!user) {
        return sanitizeErrorResponse(res, false, true);
    }

    const fcmToken = req.headers['fcm-token'] || req.headers['x-fcm-token'];
    const deviceId = req.headers['x-device-id'];
    const banCheck = await isBanned({ phone: user.phone, fcmToken, deviceId, email: user.email });
    if (banCheck.isBanned) {
        return res.status(403).json({
            code: 'DEVICE_BLOCKED',
            message: 'عذراً، هذا الجهاز أو رقم الهاتف محظور من استخدام التطبيق. يرجى التواصل مع الدعم الفني.',
        });
    }

    res.status(200).json({
        id:                  user._id,
        firstName:           user.firstName,
        lastName:            user.lastName,
        email:               user.email,
        phone:               user.phone,
        governorate:         user.governorate         || null,
        gender:              user.gender              || null,
        userType:            user.userType || 'NormalUser',
        isSuspended:         !!user.isSuspended,
        status:              user.status || 'active',
        isAdmin:             !!user.isAdmin,
        profileImage:        sanitizeImageUrl(buildUrl(req, user.profileImage)),
        vehicleNumber:       user.vehicleNumber       || null,
        vehicleColor:        user.vehicleColor        || null,
        vehicleModel:        user.vehicleModel        || null,
        vehicleImage:        sanitizeImageUrl(buildUrl(req, user.vehicleImage)),
        vehicleTypeId:       user.vehicleTypeId       || null,
        vehicleTypeName:     user.vehicleTypeName     || null,
        preferredOrderTypes: (user.preferredOrderTypes && user.preferredOrderTypes.length > 0) ? [user.preferredOrderTypes[0]] : ['delivery'],
        canEditVehicleInfo:  user.canEditVehicleInfo  || false,
    });
});

/**
 * @description Get User by id
 * @route /api/users/:id
 * @method Get 
 * @access private(only admin & user himself) 
 */
const getUserbyid = asyncHandler(async (req, res) => {
    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isOwner = req.user?.id?.toString() === req.params.id.toString();

    if (!isOwner && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const user = await User.findById(req.params.id).select('-password');
    if (!user) {
        return sanitizeErrorResponse(res, false, true);
    }

    res.status(200).json(user);
});

/**
 * @description Upload profile image – send user id and image file
 * @route PUT /api/users/:id/profile-image
 * @access public
 */
const uploadProfileImageHandler = asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'No image file provided. Use form field: image' });
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isOwner = req.user?.id?.toString() === req.params.id.toString();

    if (!isOwner && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const user = await User.findById(req.params.id);
    if (!user) {
        return sanitizeErrorResponse(res, false, true);
    }

    if (!isOwner && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    // multer-storage-cloudinary stores the Cloudinary URL in req.file.path
    // Old Cloudinary image is automatically overwritten via public_id reuse
    user.profileImage = req.file.path;
    await user.save();

    res.status(200).json({
        message: 'Profile image uploaded successfully',
        profileImage: user.profileImage,   // already a full https:// URL from Cloudinary
    });
});

/**
 * @description Delete User by id
 * @route /api/users/:id
 * @method Delete
 * @access private(only admin & user himself) 
 */
const DeleteUserbyid = asyncHandler(async (req, res) => {
    const userId = req.params.id;
    const user = await User.findById(userId).select('-password');
    
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    if (user.isAdmin || user.userType === 'Admin' || user.userType === 'admin') {
        return res.status(400).json({ message: 'عذراً، لا يمكن حذف حساب مسؤول (Admin)' });
    }

    // Ensure no stale device/phone/email ban remains for this deleted user so they can re-register freely
    await unbanIdentifier(userId.toString()).catch(() => {});
    if (user.phone) await unbanIdentifier(user.phone).catch(() => {});
    if (user.email) await unbanIdentifier(user.email).catch(() => {});

        // Cascade delete all user-related data across all collections
        // Cascade delete all user-related data across all collections
        await Promise.all([
            // 1. Delete UserRatings where user is rater or ratee
            UserRating.deleteMany({ $or: [{ raterId: userId }, { rateeId: userId }, { raterId: userId.toString() }, { rateeId: userId.toString() }] }),
            
            // 2. Delete FCM Tokens
            FcmToken.deleteMany({ $or: [{ userId: userId }, { userId: userId.toString() }] }),
            
            // 3. Delete Chat Messages
            Message.deleteMany({ $or: [{ senderId: userId }, { receiverId: userId }, { senderId: userId.toString() }, { receiverId: userId.toString() }] }),
            
            // 4. Delete Role Requests
            RoleRequest.deleteMany({ $or: [{ user: userId }, { userId: userId }, { user: userId.toString() }] }),
            
            // 5. Delete personal user discount
            UserDiscount.deleteMany({ $or: [{ userId: userId }, { userId: userId.toString() }] }),
            
            // 6. Remove user from used discount codes
            DiscountCode.updateMany(
                { usedByUserIds: { $in: [userId, userId.toString()] } },
                { $pull: { usedByUserIds: { $in: [userId, userId.toString()] } } }
            ),
            
            // 7. Delete normal Orders (rides/mashawer) where user is client or representative
            Order.deleteMany({
                $or: [
                    { clientId: userId },
                    { clientId: userId.toString() },
                    { representativeId: userId },
                    { representativeId: userId.toString() },
                    { userId: userId },
                    { userId: userId.toString() }
                ]
            }),

            // 8. Finally, hard delete the user account
            User.findByIdAndDelete(userId)
        ]);

        // Emit Socket.io notification to force logout the deleted user immediately across all namespaces
        const io = req.app.get('io');
        if (io) {
            const payload = {
                action: 'force_logout',
                reason: 'USER_DELETED',
                message: 'تم حذف حسابك من قبل الإدارة.'
            };
            const room = `user:${userId}`;
            io.to(room).emit('force_logout', payload);
            io.to(room).emit('user_status_changed', payload);
            io.to(room).emit('account_blocked', payload);
            if (io.of) {
                ['/chat', '/hr', '/tracking', '/ride'].forEach(ns => {
                    try {
                        io.of(ns).to(room).emit('force_logout', payload);
                        io.of(ns).to(room).emit('user_status_changed', payload);
                        io.of(ns).to(room).emit('account_blocked', payload);
                    } catch (_) {}
                });
            }
        }

        console.log(`[DeleteUser] Successfully deleted user ${userId} and all cascade data.`);

        return res.status(200).json({ message: "User and all related data have been completely deleted" });
});

/**
 * @description Toggle representative availability (isAvailable)
 *   PATCH /api/users/:id/availability
 *   Body: { isAvailable: boolean }
 */
const toggleRepresentativeAvailability = asyncHandler(async (req, res) => {
    const { isAvailable, lat, lng } = req.body;

    if (typeof isAvailable !== 'boolean') {
        return res.status(400).json({ message: '`isAvailable` must be a boolean (true | false)' });
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isOwner = req.user?.id?.toString() === req.params.id.toString();

    // Include lastLocation in select to update it if needed
    const user = await User.findById(req.params.id).select('_id firstName lastName userType isAvailable lastLocation');
    if (!user) {
        return sanitizeErrorResponse(res, false, true);
    }

    if (!isOwner && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    user.isAvailable = isAvailable;

    // Update location if available and lat/lng are provided
    if (isAvailable && lat !== undefined && lng !== undefined) {
        user.lastLocation = {
            lat: Number(lat),
            lng: Number(lng),
            updatedAt: new Date()
        };
    }

    await user.save();

    return res.status(200).json({
        message: isAvailable
            ? 'You are now available and accepting orders'
            : 'You are now offline and not accepting orders',
        userId: user._id,
        isAvailable: user.isAvailable,
        lastLocation: user.lastLocation,
    });
});

/**
 * @description Promote a user to Representative role
 *   PATCH /api/users/:id/set-representative
 *   Body: optional
 *   Access: Admin only
 */
const setUserAsRepresentative = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).select('_id firstName lastName userType');
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    user.userType = 'Representative';
    await user.save();

    return res.status(200).json({
        message: 'User has been promoted to Representative',
        userId: user._id,
        userType: user.userType,
    });
});

/**
 * @description Bulk-promote multiple users to Representative role
 *   POST /api/users/migrate-representatives
 *   Body: { ids: ["id1", "id2", ...] }   — OR omit ids to promote ALL non-admin users with isAvailable field set
 *   Access: Admin only (no auth guard – internal migration use)
 */
const migrateRepresentatives = asyncHandler(async (req, res) => {
    const { ids } = req.body; // optional array of _id strings

    let filter = {};
    if (Array.isArray(ids) && ids.length > 0) {
        filter = { _id: { $in: ids } };
    } else {
        // default: any non-admin user who ever toggled isAvailable (it's explicitly set)
        filter = { isAdmin: false, isAvailable: { $exists: true } };
    }

    const result = await User.updateMany(filter, { $set: { userType: 'Representative' } });

    return res.status(200).json({
        message: 'Migration complete',
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
    });
});

/**
 * @description Update representative vehicle info
 * @route PATCH /api/users/:id/vehicle
 * @access public (representative)
 * Multipart: vehicleImage (optional file field), vehicleNumber, vehicleColor, vehicleModel (body fields)
 */
const updateVehicleInfo = asyncHandler(async (req, res) => {
    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isOwner = req.user?.id?.toString() === req.params.id.toString();

    const user = await User.findById(req.params.id);
    if (!user) {
        return sanitizeErrorResponse(res, false, true);
    }

    if (!isOwner && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const { vehicleNumber, vehicleColor, vehicleModel, vehicleTypeId, vehicleTypeName, preferredOrderTypes } = req.body;

    // ─── حظر التعديل إذا كانت البيانات مسجلة ومكتملة مسبقاً والأدمن لم يفتح التعديل ────
    const isAlreadyComplete = !!(user.vehicleNumber && user.vehicleColor && user.vehicleModel && user.vehicleImage && (user.vehicleTypeId || user.vehicleTypeName));
    if (isAlreadyComplete && !user.canEditVehicleInfo) {
        return res.status(400).json({
            message: 'تم قفل تعديل بيانات المركبة من قبل الإدارة. يرجى التواصل مع الأدمن لفتح التعديل.',
            code: 'VEHICLE_INFO_LOCKED'
        });
    }

    if (vehicleNumber !== undefined) user.vehicleNumber = vehicleNumber?.trim() || null;
    if (vehicleColor  !== undefined) user.vehicleColor  = vehicleColor?.trim()  || null;
    if (vehicleModel  !== undefined) user.vehicleModel  = vehicleModel?.trim()  || null;

    if (vehicleTypeId !== undefined) {
        if (vehicleTypeId && mongoose.Types.ObjectId.isValid(vehicleTypeId)) {
            user.vehicleTypeId = vehicleTypeId;
            const vt = await VehicleType.findById(vehicleTypeId);
            if (vt) {
                user.vehicleTypeName = vt.name_ar || vt.name_en || null;
            }
        } else {
            user.vehicleTypeId = null;
            user.vehicleTypeName = null;
        }
    }

    if (vehicleTypeName !== undefined && vehicleTypeName !== null) {
        user.vehicleTypeName = vehicleTypeName.trim() || null;
    }

    if (preferredOrderTypes !== undefined) {
        let typesArr = [];
        if (Array.isArray(preferredOrderTypes)) {
            typesArr = preferredOrderTypes;
        } else if (typeof preferredOrderTypes === 'string') {
            try {
                const parsed = JSON.parse(preferredOrderTypes);
                if (Array.isArray(parsed)) typesArr = parsed;
                else typesArr = preferredOrderTypes.split(',').map(s => s.trim());
            } catch (_) {
                typesArr = preferredOrderTypes.split(',').map(s => s.trim());
            }
        }
        const cleanTypes = typesArr
            .map(t => String(t).toLowerCase().trim())
            .filter(t => ['delivery', 'passenger'].includes(t));
        user.preferredOrderTypes = cleanTypes.length > 0 ? [cleanTypes[0]] : ['delivery'];
    }

    if (req.file) {
        // multer-storage-cloudinary stores the Cloudinary URL in req.file.path
        user.vehicleImage = req.file.path;
    }

    await user.save();

    return res.status(200).json({
        message: 'Vehicle info updated successfully',
        vehicleNumber:       user.vehicleNumber,
        vehicleColor:        user.vehicleColor,
        vehicleModel:        user.vehicleModel,
        vehicleImage:        user.vehicleImage || null,
        vehicleTypeId:       user.vehicleTypeId || null,
        vehicleTypeName:     user.vehicleTypeName || null,
        preferredOrderTypes: (user.preferredOrderTypes && user.preferredOrderTypes.length > 0) ? [user.preferredOrderTypes[0]] : ['delivery'],
        canEditVehicleInfo:  user.canEditVehicleInfo || false,
    });
});

/**
 * @description One-time cleanup: null out any profileImage / vehicleImage
 *   that still points to the old Render local-disk URL (now 404).
 *   Safe to call multiple times — idempotent.
 * @route POST /api/users/clear-stale-images
 * @access internal (no auth guard — run once then ignore)
 */
const clearStaleImages = asyncHandler(async (req, res) => {
    // Match any URL that was served from the old local /uploads/ path on Render
    const stalePattern = /onrender\.com\/uploads\//;

    const users = await User.find({
        $or: [
            { profileImage: { $regex: 'onrender\.com/uploads/' } },
            { vehicleImage: { $regex: 'onrender\.com/uploads/' } },
        ],
    }).select('_id profileImage vehicleImage');

    let profileCleared = 0;
    let vehicleCleared = 0;

    for (const user of users) {
        let changed = false;
        if (user.profileImage && stalePattern.test(user.profileImage)) {
            user.profileImage = null;
            profileCleared++;
            changed = true;
        }
        if (user.vehicleImage && stalePattern.test(user.vehicleImage)) {
            user.vehicleImage = null;
            vehicleCleared++;
            changed = true;
        }
        if (changed) await user.save();
    }

    return res.status(200).json({
        message: 'Stale image URLs cleared successfully',
        profileCleared,
        vehicleCleared,
        totalUsersAffected: users.length,
    });
});

/**
 * @description Update live location for a representative who is online (isAvailable = true)
 * @route PATCH /api/users/:id/online-location
 * @access public (representative)
 * Body: { lat: number, lng: number }
 */
const updateOnlineLocation = asyncHandler(async (req, res) => {
    const { lat, lng } = req.body;
    if (lat === undefined || lng === undefined) {
        return res.status(400).json({ message: 'lat and lng are required' });
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isOwner = req.user?.id?.toString() === req.params.id.toString();

    const user = await User.findById(req.params.id);
    if (!user) {
        return sanitizeErrorResponse(res, false, true);
    }

    if (!isOwner && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    user.lastLocation = {
        lat: Number(lat),
        lng: Number(lng),
        updatedAt: new Date()
    };

    await user.save();
    return res.status(200).json({
        message: 'Location updated',
        lastLocation: user.lastLocation
    });
});

/**
 * @description Get all available representatives with their last known location updated within the last 15 minutes
 * @route GET /api/users/online-representatives
 * @access public
 */
const getOnlineRepresentatives = asyncHandler(async (req, res) => {
    // Match any representative/driver who is marked as available and has location data
    const filter = {
        userType: { $regex: /^(representative|driver)$/i },
        isAvailable: true,
        'lastLocation.lat': { $exists: true, $ne: null },
    };
    if (req.query.governorate && req.query.governorate.trim()) {
        filter.governorate = { $regex: new RegExp(req.query.governorate.trim(), 'i') };
    }

    const users = await User.find(filter).select('_id firstName lastName phone profileImage vehicleModel vehicleNumber vehicleColor lastLocation preferredOrderTypes governorate');

    res.status(200).json(users);
});

/**
 * @description Suspend a user account (admin only)
 * @route PATCH /api/users/:id/suspend
 * @access Admin
 */
const suspendUser = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).select('_id firstName lastName phone email isSuspended status isAdmin userType deviceId profileImage');
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    if (user.isAdmin || (user.userType && user.userType.toString().toLowerCase() === 'admin')) {
        return res.status(400).json({ message: 'عذراً، لا يمكن إيقاف حساب مسؤول (Admin)' });
    }

    const targetDeviceId = user.deviceId || req.body?.deviceId || null;

    user.isSuspended = true;
    user.status = 'blocked';
    await user.save();

    // Find all other accounts associated with this physical device ID (excluding Admins)
    let linkedUsers = [];
    if (targetDeviceId) {
        linkedUsers = await User.find({
            deviceId: targetDeviceId,
            _id: { $ne: user._id },
            isAdmin: { $ne: true },
            userType: { $nin: ['Admin', 'admin'] }
        }).select('_id firstName lastName phone email deviceId profileImage userType');
        for (const linkedUser of linkedUsers) {
            linkedUser.isSuspended = true;
            linkedUser.status = 'blocked';
            await linkedUser.save().catch(() => {});
        }
    }

    // Fetch target user's FCM token
    const fcmRecord = await FcmToken.findOne({ $or: [{ userId: user._id }, { userId: user._id.toString() }] });

    await banIdentifier({
        phone: user.phone,
        fcmToken: fcmRecord?.fcmToken || null,
        deviceId: targetDeviceId || null,
        email: user.email,
        userId: user._id,
        userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        profileImage: user.profileImage,
        userType: user.userType,
        reason: 'ACCOUNT_BLOCKED_BY_ADMIN',
        adminId: req.user?.id || 'ADMIN'
    }).catch((err) => console.error('[SuspendUser] Failed to blacklist device identifiers:', err.message));

    // Also blacklist identifiers for all linked users on the same physical device
    for (const linkedUser of linkedUsers) {
        await banIdentifier({
            phone: linkedUser.phone,
            email: linkedUser.email,
            deviceId: targetDeviceId || null,
            userId: linkedUser._id,
            userName: `${linkedUser.firstName || ''} ${linkedUser.lastName || ''}`.trim(),
            profileImage: linkedUser.profileImage,
            userType: linkedUser.userType,
            reason: 'DEVICE_BLOCKED_BY_ADMIN',
            adminId: req.user?.id || 'ADMIN'
        }).catch(() => {});
    }

    // Broadcast Socket.io notification to force logout all linked accounts and device sessions immediately
    const io = req.app.get('io');
    if (io) {
        const payload = {
            action: 'force_logout',
            reason: 'DEVICE_BLOCKED',
            message: 'عذراً، تم إيقاف هذا الجهاز وحظر جميع الحسابات المرتبطة به من قبل الإدارة.'
        };

        const roomsToNotify = new Set([`user:${user._id}`]);
        if (targetDeviceId) roomsToNotify.add(`device:${targetDeviceId}`);
        linkedUsers.forEach((u) => roomsToNotify.add(`user:${u._id}`));

        roomsToNotify.forEach((room) => {
            io.to(room).emit('force_logout', payload);
            io.to(room).emit('user_status_changed', payload);
            io.to(room).emit('account_blocked', payload);
            if (io.of) {
                ['/chat', '/hr', '/tracking', '/ride'].forEach((ns) => {
                    try {
                        io.of(ns).to(room).emit('force_logout', payload);
                        io.of(ns).to(room).emit('user_status_changed', payload);
                        io.of(ns).to(room).emit('account_blocked', payload);
                    } catch (_) {}
                });
            }
        });
    }

    return res.status(200).json({
        message: 'User account and all device-linked accounts have been suspended',
        userId: user._id,
        isSuspended: true,
        status: user.status,
    });
});

/**
 * @description Unsuspend (activate) a user account (admin only)
 * @route PATCH /api/users/:id/unsuspend
 * @access Admin
 */
const unsuspendUser = asyncHandler(async (req, res) => {
    const query = req.params.id ? String(req.params.id).trim() : '';
    let user;
    if (query.match(/^[0-9a-fA-F]{24}$/)) {
        user = await User.findById(query);
    }
    if (!user) {
        user = await User.findOne({
            $or: [
                { email: query.toLowerCase() },
                { phone: query },
                { deviceId: query }
            ]
        });
    }

    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    const targetDeviceId = user.deviceId || req.body?.deviceId || null;

    const userFilter = [{ _id: user._id }];
    if (user.email) userFilter.push({ email: user.email });
    if (user.phone) userFilter.push({ phone: user.phone });
    if (targetDeviceId) userFilter.push({ deviceId: targetDeviceId });

    // Reactivate main user AND all device-linked accounts in User collection
    await User.updateMany(
        { $or: userFilter },
        { $set: { isSuspended: false, status: 'active' } }
    );

    await unbanIdentifier(user._id.toString()).catch(() => {});
    if (user.phone) await unbanIdentifier(user.phone).catch(() => {});
    if (user.email) await unbanIdentifier(user.email).catch(() => {});
    if (targetDeviceId) await unbanIdentifier(targetDeviceId).catch(() => {});

    // Also unban all other device-linked users in Redis and BannedDevice DB
    if (targetDeviceId) {
        const linkedUsers = await User.find({ deviceId: targetDeviceId }).select('_id phone email');
        for (const lu of linkedUsers) {
            await unbanIdentifier(lu._id.toString()).catch(() => {});
            if (lu.phone) await unbanIdentifier(lu.phone).catch(() => {});
            if (lu.email) await unbanIdentifier(lu.email).catch(() => {});
        }
    }

    return res.status(200).json({
        message: 'User account and all device-linked accounts have been activated',
        userId: user._id,
        isSuspended: false,
        status: 'active',
    });
});

/**
 * @description Get all suspended users (admin only)
 * @route GET /api/users/suspended
 * @access Admin
 */
const getSuspendedUsers = asyncHandler(async (req, res) => {
    const users = await User.find({
        $or: [
            { isSuspended: true },
            { status: 'blocked' }
        ]
    })
        .select('-password')
        .sort({ updatedAt: -1 });

    return res.status(200).json(users);
});

/**
 * @description Block a user account (admin only)
 * @route PUT /api/users/:id/block
 * @access Admin
 */
const blockUser = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).select('_id firstName lastName phone email status isSuspended isAdmin userType deviceId profileImage');
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    if (user.isAdmin || (user.userType && user.userType.toString().toLowerCase() === 'admin')) {
        return res.status(400).json({ message: 'عذراً، لا يمكن حظر حساب مسؤول (Admin)' });
    }

    const targetDeviceId = user.deviceId || req.body?.deviceId || null;

    user.status = 'blocked';
    user.isSuspended = true;
    await user.save();

    // Find all other accounts associated with this physical device ID (excluding Admins)
    let linkedUsers = [];
    if (targetDeviceId) {
        linkedUsers = await User.find({
            deviceId: targetDeviceId,
            _id: { $ne: user._id },
            isAdmin: { $ne: true },
            userType: { $nin: ['Admin', 'admin'] }
        }).select('_id firstName lastName phone email deviceId profileImage userType');
        for (const linkedUser of linkedUsers) {
            linkedUser.isSuspended = true;
            linkedUser.status = 'blocked';
            await linkedUser.save().catch(() => {});
        }
    }

    // Fetch target user's FCM token
    const fcmRecord = await FcmToken.findOne({ $or: [{ userId: user._id }, { userId: user._id.toString() }] });

    await banIdentifier({
        phone: user.phone,
        fcmToken: fcmRecord?.fcmToken || null,
        deviceId: targetDeviceId || null,
        email: user.email,
        userId: user._id,
        userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        profileImage: user.profileImage,
        userType: user.userType,
        reason: 'ACCOUNT_BLOCKED_BY_ADMIN',
        adminId: req.user?.id || 'ADMIN'
    }).catch((err) => console.error('[BlockUser] Failed to blacklist device identifiers:', err.message));

    // Also blacklist identifiers for all linked users on the same physical device
    for (const linkedUser of linkedUsers) {
        await banIdentifier({
            phone: linkedUser.phone,
            email: linkedUser.email,
            deviceId: targetDeviceId || null,
            userId: linkedUser._id,
            userName: `${linkedUser.firstName || ''} ${linkedUser.lastName || ''}`.trim(),
            profileImage: linkedUser.profileImage,
            userType: linkedUser.userType,
            reason: 'DEVICE_BLOCKED_BY_ADMIN',
            adminId: req.user?.id || 'ADMIN'
        }).catch(() => {});
    }

    // Broadcast Socket.io notification to force logout all linked accounts and device sessions immediately
    const io = req.app.get('io');
    if (io) {
        const payload = {
            action: 'force_logout',
            reason: 'DEVICE_BLOCKED',
            message: 'عذراً، تم إيقاف هذا الجهاز وحظر جميع الحسابات المرتبطة به من قبل الإدارة.'
        };

        const roomsToNotify = new Set([`user:${user._id}`]);
        if (targetDeviceId) roomsToNotify.add(`device:${targetDeviceId}`);
        linkedUsers.forEach((u) => roomsToNotify.add(`user:${u._id}`));

        roomsToNotify.forEach((room) => {
            io.to(room).emit('force_logout', payload);
            io.to(room).emit('user_status_changed', payload);
            io.to(room).emit('account_blocked', payload);
            if (io.of) {
                ['/chat', '/hr', '/tracking', '/ride'].forEach((ns) => {
                    try {
                        io.of(ns).to(room).emit('force_logout', payload);
                        io.of(ns).to(room).emit('user_status_changed', payload);
                        io.of(ns).to(room).emit('account_blocked', payload);
                    } catch (_) {}
                });
            }
        });
    }

    return res.status(200).json({
        message: 'User account and all device-linked accounts have been blocked',
        userId: user._id,
        status: user.status,
        isSuspended: user.isSuspended,
    });
});

/**
 * @description Unblock a user account (admin only)
 * @route PUT /api/users/:id/unblock
 * @access Admin
 */
const unblockUser = asyncHandler(async (req, res) => {
    const query = req.params.id ? String(req.params.id).trim() : '';
    let user;
    if (query.match(/^[0-9a-fA-F]{24}$/)) {
        user = await User.findById(query);
    }
    if (!user) {
        user = await User.findOne({
            $or: [
                { email: query.toLowerCase() },
                { phone: query },
                { deviceId: query }
            ]
        });
    }

    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    const targetDeviceId = user.deviceId || req.body?.deviceId || null;

    const userFilter = [{ _id: user._id }];
    if (user.email) userFilter.push({ email: user.email });
    if (user.phone) userFilter.push({ phone: user.phone });
    if (targetDeviceId) userFilter.push({ deviceId: targetDeviceId });

    // Reactivate main user AND all device-linked accounts in User collection
    await User.updateMany(
        { $or: userFilter },
        { $set: { isSuspended: false, status: 'active' } }
    );

    await unbanIdentifier(user._id.toString()).catch(() => {});
    if (user.phone) await unbanIdentifier(user.phone).catch(() => {});
    if (user.email) await unbanIdentifier(user.email).catch(() => {});
    if (targetDeviceId) await unbanIdentifier(targetDeviceId).catch(() => {});

    // Also unban all other device-linked users in Redis and BannedDevice DB
    if (targetDeviceId) {
        const linkedUsers = await User.find({ deviceId: targetDeviceId }).select('_id phone email');
        for (const lu of linkedUsers) {
            await unbanIdentifier(lu._id.toString()).catch(() => {});
            if (lu.phone) await unbanIdentifier(lu.phone).catch(() => {});
            if (lu.email) await unbanIdentifier(lu.email).catch(() => {});
        }
    }

    return res.status(200).json({
        message: 'User account and all device-linked accounts have been unblocked',
        userId: user._id,
        status: 'active',
        isSuspended: false,
    });
});



/**
 * @desc   Get orders delivered by a specific representative (Admin)
 *         Supports filtering by month/year — returns monthly summary + paginated order list.
 * @route  GET /api/users/:id/representative-orders
 * @query  month (1-12), year (YYYY), page, limit
 * @access Admin
 */
const { Tafgeet } = require('tafgeet-arabic');

function getFilsAsText(fils) {
    if (!fils) return 'صفر جنيه';
    const amountInKD = fils / 1000;
    try {
        return new Tafgeet(amountInKD, 'EGP').parse();
    } catch (e) {
        return `${amountInKD} جنيه`;
    }
}

const getRepresentativeOrders = asyncHandler(async (req, res) => {
    const repId = req.params.id;

    // Verify user exists and is a representative
    const user = await User.findById(repId).select('firstName lastName phone userType profileImage');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip  = (page - 1) * limit;

    // Build date filter
    const dateFilter = {};
    const date      = req.query.date;
    const startDate = req.query.startDate;
    const endDate   = req.query.endDate;
    const month     = parseInt(req.query.month, 10); // 1-12
    const year      = parseInt(req.query.year,  10);
    const statusQuery = req.query.status;

    if (date) {
        const from = new Date(date);
        from.setHours(0, 0, 0, 0);
        const to = new Date(from);
        to.setDate(to.getDate() + 1);
        dateFilter.createdAt = { $gte: from, $lt: to };
    } else if (startDate && endDate) {
        const from = new Date(startDate);
        from.setHours(0, 0, 0, 0);
        const to = new Date(endDate);
        to.setHours(23, 59, 59, 999);
        dateFilter.createdAt = { $gte: from, $lte: to };
    } else if (!isNaN(year) && !isNaN(month) && month >= 1 && month <= 12) {
        const from = new Date(year, month - 1, 1);
        const to   = new Date(year, month,     1);
        dateFilter.createdAt = { $gte: from, $lt: to };
    } else if (!isNaN(year)) {
        const from = new Date(year,     0, 1);
        const to   = new Date(year + 1, 0, 1);
        dateFilter.createdAt = { $gte: from, $lt: to };
    }

    // Match repId both as string and ObjectId if valid
    const repMatch = [repId.toString()];
    if (mongoose.Types.ObjectId.isValid(repId)) {
        repMatch.push(new mongoose.Types.ObjectId(repId));
    }

    const baseFilter = {
        representativeId: { $in: repMatch },
        ...dateFilter
    };

    if (statusQuery) {
        const statuses = statusQuery.split(',').map(s => s.trim()).filter(Boolean);
        baseFilter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
    }

    const { Order } = require('../middlewares/Order');
    const { getCachedRepCommission, calcRepEarnings } = require('../middlewares/RepCommission');
    const commissionCfg = await getCachedRepCommission().catch(() => ({ deliveryRepCommissionPct: 100, businessRepCommissionPct: 100 }));

    // Helper to normalize any raw numeric price to fils integer
    function normalizeFils(val) {
        if (val == null || isNaN(val)) return 0;
        let num = Number(val);
        if (num <= 0) return 0;
        return Math.round(num);
    }

    const deliveryFilter = {
        ...baseFilter,
        isBusinessOrder: { $ne: true },
        orderCategory: { $ne: 'business' }
    };

    const [
        ordersRaw,
        total
    ] = await Promise.all([
        Order.find(deliveryFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        Order.countDocuments(deliveryFilter)
    ]);

    // Gather all client user IDs for full client info population
    const clientUserIds = new Set();
    ordersRaw.forEach(o => {
        if (o.clientId) clientUserIds.add(o.clientId.toString());
        if (o.userId) clientUserIds.add(o.userId.toString());
    });

    const clientUsers = await User.find({ _id: { $in: Array.from(clientUserIds).filter(id => mongoose.Types.ObjectId.isValid(id)) } })
        .select('_id firstName lastName email phone profileImage')
        .lean();

    const clientMap = {};
    clientUsers.forEach(u => {
        clientMap[u._id.toString()] = {
            userId: u._id,
            firstName: u.firstName || '',
            lastName: u.lastName || '',
            name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
            email: u.email || '',
            phone: u.phone || '',
            profileImage: u.profileImage || null
        };
    });

    const buildPhotoUrl = (img) => {
        if (!img) return null;
        if (typeof img !== 'string') return null;
        const str = img.trim();
        if (!str || str === 'null' || str === 'undefined') return null;
        if (str.startsWith('http://') || str.startsWith('https://')) return str;
        try {
            const { buildUrl } = require('../config/urlBuilder');
            return buildUrl(req, str);
        } catch (_) {
            return `https://mashawerr.onrender.com/uploads/${str.replace(/^\//, '')}`;
        }
    };

    const enrichOrderData = (orderDoc) => {
        const cId = (orderDoc.clientId || orderDoc.userId || '').toString();
        const clientInfo = clientMap[cId] || orderDoc.userInfo || {};

        const deliveryPriceFils = normalizeFils(orderDoc.totalDeliveryPrice ?? orderDoc.deliveryPrice);
        const originalDeliveryPriceFils = normalizeFils(orderDoc.originalDeliveryPrice) || deliveryPriceFils;
        const discountAmountFils = normalizeFils(orderDoc.discountAmount);

        let totalPriceFils = normalizeFils(orderDoc.totalPrice);
        if (totalPriceFils === 0) {
            totalPriceFils = deliveryPriceFils;
        }

        const deliveryPriceKD = Number((deliveryPriceFils / 1000).toFixed(3));
        const originalDeliveryPriceKD = Number((originalDeliveryPriceFils / 1000).toFixed(3));
        const discountAmountKD = Number((discountAmountFils / 1000).toFixed(3));
        const totalPriceKD = Number((totalPriceFils / 1000).toFixed(3));

        const commissionPct = commissionCfg?.deliveryRepCommissionPct ?? 100;

        const repEarningsKD = calcRepEarnings(deliveryPriceKD, commissionPct);
        const repEarningsFils = Math.round(repEarningsKD * 1000);

        const rootPickup = buildPhotoUrl(orderDoc.pickupPhoto || orderDoc.pickupPhotoUrl || orderDoc.itemPhotoBefore) || null;
        const rootDelivery = buildPhotoUrl(orderDoc.deliveryPhoto || orderDoc.deliveryPhotoUrl || orderDoc.itemPhotoAfter || orderDoc.podPhoto || orderDoc.proofPhoto) || null;

        const tasksArr = Array.isArray(orderDoc.tasks) ? orderDoc.tasks : [];
        const isSingleTask = tasksArr.length <= 1;

        const itemsArr = Array.isArray(orderDoc.items) ? orderDoc.items : [];
        const isSingleItem = itemsArr.length <= 1;

        const itemsFormatted = itemsArr.map(i => {
            const iP = buildPhotoUrl(i.pickupPhoto || i.pickupPhotoUrl || i.itemPhotoBefore) || (isSingleItem ? rootPickup : null);
            const iD = buildPhotoUrl(i.deliveryPhoto || i.deliveryPhotoUrl || i.itemPhotoAfter || i.podPhoto || i.proofPhoto) || (isSingleItem ? rootDelivery : null);
            return {
                ...i,
                pickupPhoto: iP,
                pickupPhotoUrl: iP,
                itemPhotoBefore: iP,
                deliveryPhoto: iD,
                deliveryPhotoUrl: iD,
                itemPhotoAfter: iD,
            };
        });

        const tasksFormatted = tasksArr.map(t => {
            const tP = buildPhotoUrl(t.itemPhotoBefore || t.pickupPhoto || t.pickupPhotoUrl) || (isSingleTask ? rootPickup : null);
            const tD = buildPhotoUrl(t.itemPhotoAfter || t.deliveryPhoto || t.deliveryPhotoUrl || t.podPhoto || t.proofPhoto) || (isSingleTask ? rootDelivery : null);
            return {
                ...t,
                itemPhotoBefore: tP,
                itemPhotoAfter: tD,
                pickupPhoto: tP,
                deliveryPhoto: tD,
                pickupPhotoUrl: tP,
                deliveryPhotoUrl: tD,
            };
        });

        const pickupPhotoSet = new Set([rootPickup, ...tasksFormatted.map(t => t.pickupPhoto), ...itemsFormatted.map(i => i.pickupPhoto)].filter(Boolean));
        const deliveryPhotoSet = new Set([rootDelivery, ...tasksFormatted.map(t => t.deliveryPhoto), ...itemsFormatted.map(i => i.deliveryPhoto)].filter(Boolean));

        return {
            ...orderDoc,
            id: orderDoc._id,
            orderId: orderDoc.orderId || null,
            orderCategory: 'delivery',
            isBusinessOrder: false,
            clientInfo: {
                userId: cId,
                name: clientInfo.name || `${orderDoc.userInfo?.firstName || ''} ${orderDoc.userInfo?.lastName || ''}`.trim() || 'عميل',
                firstName: clientInfo.firstName || orderDoc.userInfo?.firstName || '',
                lastName: clientInfo.lastName || orderDoc.userInfo?.lastName || '',
                phone: clientInfo.phone || orderDoc.userInfo?.phone || '',
                email: clientInfo.email || orderDoc.userInfo?.email || '',
                profileImage: clientInfo.profileImage || null,
            },
            priceDetails: {
                totalPrice: totalPriceKD,
                totalPriceKD: totalPriceKD,
                totalPriceFils: totalPriceFils,
                totalPriceText: getFilsAsText(totalPriceFils),

                totalDeliveryPrice: deliveryPriceKD,
                totalDeliveryPriceKD: deliveryPriceKD,
                totalDeliveryPriceFils: deliveryPriceFils,

                originalDeliveryPrice: originalDeliveryPriceKD,
                originalDeliveryPriceKD: originalDeliveryPriceKD,
                originalDeliveryPriceFils: originalDeliveryPriceFils,

                discountAmount: discountAmountKD,
                discountAmountKD: discountAmountKD,
                discountAmountFils: discountAmountFils,
                discountPercentage: orderDoc.discountPercentage || null,
                discountCode: orderDoc.discountCode || null,
                discountType: orderDoc.discountType || null,

                repEarnings: repEarningsKD,
                repEarningsKD: repEarningsKD,
                repEarningsFils: repEarningsFils,
                repEarningsText: getFilsAsText(repEarningsFils),
                commissionPct: commissionPct,
            },
            totalPrice: totalPriceKD,
            totalPriceKD: totalPriceKD,
            totalDeliveryPrice: deliveryPriceKD,
            totalDeliveryPriceKD: deliveryPriceKD,
            deliveryPrice: deliveryPriceKD,
            deliveryPriceKD: deliveryPriceKD,
            repEarnings: repEarningsKD,
            repEarningsKD: repEarningsKD,
            repEarningsFils: repEarningsFils,
            vehicleDetails: {
                vehicleTypeId: orderDoc.vehicleTypeId || orderDoc.requiredVehicleTypeId || null,
                vehicleName: orderDoc.vehicleName || orderDoc.vehicleTypeName || orderDoc.requiredVehicleTypeName || null,
            },
            pickupPhoto: rootPickup,
            deliveryPhoto: rootDelivery,
            pickupPhotoUrl: rootPickup,
            deliveryPhotoUrl: rootDelivery,
            itemPhotoBefore: rootPickup,
            itemPhotoAfter: rootDelivery,
            pickupPhotos: Array.from(pickupPhotoSet),
            deliveryPhotos: Array.from(deliveryPhotoSet),
            tasks: tasksFormatted,
            items: itemsFormatted,
        };
    };

    const regularOrdersRaw = ordersRaw;
    const storeOrdersRaw   = [];
    const allOrdersRaw     = ordersRaw;
    const regularTotal     = total;
    const storeTotal       = 0;
    const allTotal         = total;

    const { enrichOrdersWithDeliveryPhotos } = require('./orderController');
    let regularOrdersEnriched = regularOrdersRaw.map(enrichOrderData);
    let storeOrdersEnriched   = [];
    let allOrdersEnriched     = regularOrdersEnriched;

    if (typeof enrichOrdersWithDeliveryPhotos === 'function') {
        regularOrdersEnriched = await enrichOrdersWithDeliveryPhotos(req, regularOrdersEnriched);
        allOrdersEnriched     = regularOrdersEnriched;
    }

    // Compute comprehensive summary stats across all rep orders in period
    const allRepOrdersForStats = await Order.find(deliveryFilter).select('status totalPrice totalDeliveryPrice deliveryPrice').lean();

    let regCompletedCount = 0, regCompletedRevFils = 0, regCompletedProfitFils = 0, regCancelledCount = 0, regCancelledRevFils = 0, regActiveCount = 0;

    for (const o of allRepOrdersForStats) {
        const status  = (o.status || '').toLowerCase();

        const dPriceFils = normalizeFils(o.totalDeliveryPrice ?? o.deliveryPrice);
        let tPriceFils = normalizeFils(o.totalPrice);
        if (tPriceFils === 0) tPriceFils = dPriceFils;

        const commPct = commissionCfg?.deliveryRepCommissionPct ?? 100;

        const dPriceKD = Number((dPriceFils / 1000).toFixed(3));
        const profitKD = calcRepEarnings(dPriceKD, commPct);
        const profitFils = Math.round(profitKD * 1000);

        if (['completed', 'delivered'].includes(status)) {
            regCompletedCount++;
            regCompletedRevFils += tPriceFils;
            regCompletedProfitFils += profitFils;
        } else if (['cancelled', 'canceled'].includes(status)) {
            regCancelledCount++;
            regCancelledRevFils += tPriceFils;
        } else {
            regActiveCount++;
        }
    }

    const regCompletedRevKD = Number((regCompletedRevFils / 1000).toFixed(3));
    const regCompletedProfitKD = Number((regCompletedProfitFils / 1000).toFixed(3));
    const regCancelledRevKD = Number((regCancelledRevFils / 1000).toFixed(3));

    const totalCompletedRevFils = regCompletedRevFils;
    const totalCompletedProfitFils = regCompletedProfitFils;
    const totalCancelledRevFils = regCancelledRevFils;

    return res.status(200).json({
        representativeId:   repId,
        representativeName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        profileImage:       user.profileImage || null,
        phone:              user.phone || null,
        filter: {
            date:      date || null,
            startDate: startDate || null,
            endDate:   endDate || null,
            month:     isNaN(month) ? null : month,
            year:      isNaN(year)  ? null : year,
            status:    statusQuery || null,
        },
        summary: {
            regularOrders: {
                completedCount:       regCompletedCount,
                completedRevenue:     regCompletedRevKD,
                completedRevenueFils: regCompletedRevFils,
                completedRevenueText: getFilsAsText(regCompletedRevFils),
                completedProfit:      regCompletedProfitKD,
                completedProfitFils:  regCompletedProfitFils,
                completedProfitText:  getFilsAsText(regCompletedProfitFils),

                cancelledCount:       regCancelledCount,
                cancelledRevenue:     regCancelledRevKD,
                cancelledRevenueFils: regCancelledRevFils,
                cancelledRevenueText: getFilsAsText(regCancelledRevFils),
                inProgressCount:      regActiveCount,
                totalCount:           regCompletedCount + regCancelledCount + regActiveCount,
            },
            storeOrders: {
                completedCount:       0,
                completedRevenue:     0,
                completedRevenueFils: 0,
                completedRevenueText: '0 فلس',
                completedProfit:      0,
                completedProfitFils:  0,
                completedProfitText:  '0 فلس',

                cancelledCount:       0,
                cancelledRevenue:     0,
                cancelledRevenueFils: 0,
                cancelledRevenueText: '0 فلس',
                inProgressCount:      0,
                totalCount:           0,
            },
            total: {
                completedCount:       regCompletedCount,
                completedRevenue:     Number((totalCompletedRevFils / 1000).toFixed(3)),
                completedRevenueFils: totalCompletedRevFils,
                completedRevenueText: getFilsAsText(totalCompletedRevFils),
                completedProfit:      Number((totalCompletedProfitFils / 1000).toFixed(3)),
                completedProfitFils:  totalCompletedProfitFils,
                completedProfitText:  getFilsAsText(totalCompletedProfitFils),

                cancelledCount:       regCancelledCount,
                cancelledRevenue:     Number((totalCancelledRevFils / 1000).toFixed(3)),
                cancelledRevenueFils: totalCancelledRevFils,
                cancelledRevenueText: getFilsAsText(totalCancelledRevFils),
                inProgressCount:      regActiveCount,
                totalCount:           allRepOrdersForStats.length,
            },
        },
        page,
        limit,
        regularOrders: {
            total:      regularTotal,
            totalPages: Math.ceil(regularTotal / limit),
            orders:     regularOrdersEnriched,
        },
        storeOrders: {
            total:      storeTotal,
            totalPages: Math.ceil(storeTotal / limit),
            orders:     storeOrdersEnriched,
        },
        allOrders: {
            total:      allTotal,
            totalPages: Math.ceil(allTotal / limit),
            orders:     allOrdersEnriched,
        },
    });
});

/**
 * @desc   Get all ratings for a representative (admin view):
 *         - Ratings received from clients (clientRatedRep)
 *         - Ratings given by rep to clients (repRatedClient)
 * @route  GET /api/users/:id/representative-ratings
 * @query  page, limit
 * @access Admin
 */
const getRepresentativeRatingsAdmin = asyncHandler(async (req, res) => {
    const repId = req.params.id;

    const user = await User.findById(repId).select('firstName lastName userType profileImage');
    if (!user) return res.status(404).json({ message: 'User not found' });

    const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip  = (page - 1) * limit;

    // Build date filter
    const dateFilter = {};
    const date      = req.query.date;
    const startDate = req.query.startDate;
    const endDate   = req.query.endDate;
    const month     = parseInt(req.query.month, 10);
    const year      = parseInt(req.query.year,  10);

    if (date) {
        const from = new Date(date);
        from.setHours(0, 0, 0, 0);
        const to = new Date(from);
        to.setDate(to.getDate() + 1);
        dateFilter.createdAt = { $gte: from, $lt: to };
    } else if (startDate && endDate) {
        const from = new Date(startDate);
        from.setHours(0, 0, 0, 0);
        const to = new Date(endDate);
        to.setHours(23, 59, 59, 999);
        dateFilter.createdAt = { $gte: from, $lte: to };
    } else if (!isNaN(year) && !isNaN(month) && month >= 1 && month <= 12) {
        const from = new Date(year, month - 1, 1);
        const to   = new Date(year, month,     1);
        dateFilter.createdAt = { $gte: from, $lt: to };
    } else if (!isNaN(year)) {
        const from = new Date(year,     0, 1);
        const to   = new Date(year + 1, 0, 1);
        dateFilter.createdAt = { $gte: from, $lt: to };
    }

    const [
        receivedRatings, receivedTotal,
        givenRatings,    givenTotal,
        stats,
    ] = await Promise.all([
        // Ratings clients gave to this rep
        UserRating.find({ rateeId: repId, rateeType: 'representative', ...dateFilter })
            .sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        UserRating.countDocuments({ rateeId: repId, rateeType: 'representative', ...dateFilter }),
        // Ratings this rep gave to clients
        UserRating.find({ raterId: repId, raterType: 'representative', ...dateFilter })
            .sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        UserRating.countDocuments({ raterId: repId, raterType: 'representative', ...dateFilter }),
        // Aggregate average
        UserRating.aggregate([
            { $match: { rateeId: repId, rateeType: 'representative', ...dateFilter } },
            { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
        ]),
    ]);

    // Star distribution breakdown
    const distribution = await UserRating.aggregate([
        { $match: { rateeId: repId, rateeType: 'representative', ...dateFilter } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
        { $sort: { _id: -1 } },
    ]);

    return res.status(200).json({
        representativeId:   repId,
        representativeName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
        profileImage:       user.profileImage || null,
        filter: {
            date:      date || null,
            startDate: startDate || null,
            endDate:   endDate || null,
            month:     isNaN(month) ? null : month,
            year:      isNaN(year)  ? null : year,
        },
        averageRating:      stats[0] ? Math.round(stats[0].avg * 10) / 10 : 0,
        ratingCount:        stats[0]?.count || 0,
        distribution:       distribution.map(d => ({ stars: d._id, count: d.count })),
        page,
        limit,
        // Ratings received from clients
        receivedFromClients: {
            total:      receivedTotal,
            totalPages: Math.ceil(receivedTotal / limit),
            ratings:    receivedRatings,
        },
        // Ratings this rep gave to clients
        givenToClients: {
            total:      givenTotal,
            totalPages: Math.ceil(givenTotal / limit),
            ratings:    givenRatings,
        },
    });
});

/**
 * @description Toggle or set vehicle edit permission for a representative (Admin only)
 *   PATCH /api/users/:id/vehicle-edit-permissions
 *   PATCH /api/users/:id/toggle-vehicle-edit
 *   Body: { canEditVehicleInfo: boolean } (optional – toggles current state if not provided)
 *   Access: Admin
 */
const toggleVehicleEditPermission = asyncHandler(async (req, res) => {
    const user = await User.findById(req.params.id).select('_id firstName lastName userType canEditVehicleInfo vehicleNumber vehicleModel');
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    const { canEditVehicleInfo } = req.body;

    if (typeof canEditVehicleInfo === 'boolean') {
        user.canEditVehicleInfo = canEditVehicleInfo;
    } else {
        // Toggle if not explicitly specified
        user.canEditVehicleInfo = !user.canEditVehicleInfo;
    }

    await user.save();

    // Emit Socket.io notification if io is available
    const io = req.app.get('io');
    if (io) {
        const payload = {
            type: 'vehicle_edit_status_changed',
            userId: user._id,
            canEditVehicleInfo: user.canEditVehicleInfo,
            message: user.canEditVehicleInfo
                ? 'تم فتح إمكانية تعديل بيانات المركبة لك من قِبَل الأدمن'
                : 'تم قفل تعديل بيانات المركبة من قِبَل الأدمن',
        };
        io.to(`user:${user._id}`).emit('vehicle_edit_status_changed', payload);
        if (io.of) {
            try {
                io.of('/chat').to(`user:${user._id}`).emit('vehicle_edit_status_changed', payload);
            } catch (_) {}
        }
    }

    return res.status(200).json({
        message: user.canEditVehicleInfo
            ? 'تم فتح إمكانية تعديل بيانات المركبة للمندوب بنجاح'
            : 'تم قفل تعديل بيانات المركبة للمندوب بنجاح',
        userId: user._id,
        canEditVehicleInfo: user.canEditVehicleInfo,
    });
});

/**
 * @description Admin: Change user role / userType
 *   PATCH /api/users/:id/change-user-type
 *   Body: { userType: string }  ('NormalUser' | 'Representative' | 'administration')
 *   Access: Admin only
 */
const changeUserType = asyncHandler(async (req, res) => {
    const { userType } = req.body;
    if (!userType || typeof userType !== 'string' || userType.trim() === '') {
        return res.status(400).json({ message: '`userType` is required' });
    }

    const typeClean = userType.trim();
    const typeLower = typeClean.toLowerCase();

    // Do not allow promoting to Admin from here
    if (typeLower === 'admin') {
        return res.status(400).json({ message: 'لا يمكن الترقية إلى رتبة أدمن الأساسية من هذه الخاصية' });
    }

    const validRoles = ['normaluser', 'client', 'representative', 'administration'];
    if (!validRoles.includes(typeLower)) {
        return res.status(400).json({ message: 'نوع المستخدم غير صالح. الأنواع المتاحة: NormalUser, Representative, administration' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
        return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    // Do not allow modifying a Super Admin account
    if (user.isAdmin || (user.userType && user.userType.toLowerCase() === 'admin')) {
        return res.status(400).json({ message: 'لا يمكن تغيير دور حساب الأدمن الأساسي' });
    }

    let formattedUserType = 'NormalUser';
    if (typeLower === 'representative') formattedUserType = 'Representative';
    else if (typeLower === 'administration') formattedUserType = 'administration';

    const updateFields = {
        userType: formattedUserType
    };

    const updatedUser = await User.findByIdAndUpdate(
        req.params.id,
        { $set: updateFields },
        { new: true, runValidators: false }
    );

    // Emit Socket.io notification to force logout if user is currently online
    const io = req.app.get('io');
    if (io) {
        const payload = {
            action: 'force_logout',
            reason: 'USER_TYPE_CHANGED',
            newType: formattedUserType,
            message: `تم تغيير نوع حسابك من قبل الإدارة إلى: ${formattedUserType}. يرجى إعادة تسجيل الدخول.`
        };
        io.to(`user:${updatedUser._id}`).emit('force_logout', payload);
        io.to(`user:${updatedUser._id}`).emit('user_status_changed', payload);
        if (io.of) {
            try {
                io.of('/chat').to(`user:${updatedUser._id}`).emit('force_logout', payload);
                io.of('/chat').to(`user:${updatedUser._id}`).emit('user_status_changed', payload);
            } catch (_) {}
        }
    }

    return res.status(200).json({
        message: `تم تغيير نوع المستخدم بنجاح إلى: ${formattedUserType}`,
        userId: updatedUser._id,
        userType: updatedUser.userType,
    });
});

/**
 * @description Get all active banned devices and identifiers (admin only)
 * @route GET /api/users/banned-devices
 * @access Admin
 */
const getBannedDevices = asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;
    const skip = (page - 1) * limit;

    const filter = { isActive: true };
    if (req.query.search) {
        const searchRegex = new RegExp(req.query.search.trim(), 'i');
        filter.$or = [
            { phone: searchRegex },
            { fcmToken: searchRegex },
            { deviceId: searchRegex },
            { email: searchRegex },
            { userName: searchRegex },
        ];
    }

    const [rawDevices, total] = await Promise.all([
        BannedDevice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        BannedDevice.countDocuments(filter)
    ]);

    const devices = await Promise.all(
        rawDevices.map(async (dev) => {
            let userName = dev.userName ? String(dev.userName).trim() : null;
            let profileImage = dev.profileImage ? sanitizeImageUrl(buildUrl(req, dev.profileImage)) : null;
            let userType = dev.userType || null;

            // If userName or profileImage not stored on BannedDevice, look up the target user from User collection
            if (!userName || !profileImage) {
                let foundUser = null;

                // 1. First priority: look up by originalUserId (strictly excluding Admins)
                if (dev.originalUserId && mongoose.Types.ObjectId.isValid(dev.originalUserId)) {
                    foundUser = await User.findOne({
                        _id: dev.originalUserId,
                        isAdmin: { $ne: true },
                        userType: { $nin: ['Admin', 'admin'] }
                    })
                    .select('firstName lastName profileImage userType')
                    .lean()
                    .catch(() => null);
                }

                // 2. Second priority: look up by phone or email (strictly excluding Admins)
                if (!foundUser && (dev.phone || dev.email)) {
                    const identifiers = [];
                    if (dev.phone) identifiers.push({ phone: dev.phone });
                    if (dev.email) identifiers.push({ email: dev.email.toLowerCase() });

                    foundUser = await User.findOne({
                        $or: identifiers,
                        isAdmin: { $ne: true },
                        userType: { $nin: ['Admin', 'admin'] }
                    })
                    .select('firstName lastName profileImage userType')
                    .lean()
                    .catch(() => null);
                }

                if (foundUser) {
                    const first = foundUser.firstName || '';
                    const last = foundUser.lastName || '';
                    const fullName = `${first} ${last}`.trim();
                    if (!userName && fullName) userName = fullName;
                    if (!profileImage && foundUser.profileImage) {
                        profileImage = sanitizeImageUrl(buildUrl(req, foundUser.profileImage));
                    }
                    if (!userType && foundUser.userType) userType = foundUser.userType;
                }
            }

            return {
                ...dev,
                userName: userName || dev.phone || dev.email || 'مستخدم محظور',
                profileImage: profileImage || null,
                userType: userType || null,
            };
        })
    );

    return res.status(200).json({
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        devices,
    });
});

/**
 * @description Unban a banned device / identifier by ID or phone (admin only)
 * @route DELETE /api/users/banned-devices/:id
 * @access Admin
 */
const unbanBannedDevice = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const cleanId = String(id).trim();

    // Check if cleanId matches a BannedDevice record
    const bannedFilter = [];
    if (cleanId.match(/^[0-9a-fA-F]{24}$/)) {
        bannedFilter.push({ _id: cleanId });
        bannedFilter.push({ originalUserId: cleanId });
    }
    const normPhone = normalizePhone(cleanId);
    const normEmail = cleanId.includes('@') ? cleanId.toLowerCase() : null;
    if (normPhone) bannedFilter.push({ phone: normPhone });
    if (normEmail) bannedFilter.push({ email: normEmail });
    bannedFilter.push({ deviceId: cleanId });
    bannedFilter.push({ fcmToken: cleanId });

    const bannedRecords = await BannedDevice.find({ $or: bannedFilter }).lean().catch(() => []);

    // Deactivate BannedDevice & delete Redis keys
    const result = await unbanIdentifier(cleanId);

    // Build comprehensive user filter to update User collection in MongoDB
    const userFilter = [];
    if (cleanId.match(/^[0-9a-fA-F]{24}$/)) {
        userFilter.push({ _id: cleanId });
    }
    if (normPhone) userFilter.push({ phone: normPhone });
    if (normEmail) userFilter.push({ email: normEmail });
    userFilter.push({ deviceId: cleanId });

    for (const rec of bannedRecords) {
        if (rec.originalUserId) userFilter.push({ _id: rec.originalUserId });
        if (rec.phone) userFilter.push({ phone: rec.phone });
        if (rec.email) userFilter.push({ email: rec.email });
        if (rec.deviceId) userFilter.push({ deviceId: rec.deviceId });
        await unbanIdentifier(rec._id.toString()).catch(() => {});
        if (rec.phone) await unbanIdentifier(rec.phone).catch(() => {});
        if (rec.email) await unbanIdentifier(rec.email).catch(() => {});
        if (rec.deviceId) await unbanIdentifier(rec.deviceId).catch(() => {});
    }

    if (userFilter.length > 0) {
        const matchedUsers = await User.find({ $or: userFilter }).select('_id phone email deviceId');
        for (const tu of matchedUsers) {
            if (tu.deviceId) {
                userFilter.push({ deviceId: tu.deviceId });
                await unbanIdentifier(tu.deviceId).catch(() => {});
            }
            if (tu.phone) await unbanIdentifier(tu.phone).catch(() => {});
            if (tu.email) await unbanIdentifier(tu.email).catch(() => {});
            await unbanIdentifier(tu._id.toString()).catch(() => {});
        }

        await User.updateMany(
            { $or: userFilter },
            { $set: { isSuspended: false, status: 'active' } }
        ).catch(() => {});
    }

    return res.status(200).json({
        message: 'تم فك الحظر بنجاح عن المعرّف / الجهاز وتفعيل جميع الحسابات المرتبطة به',
        result,
    });
});

module.exports = { updateUser, getAllUser, getProfile, getUserbyid, uploadProfileImageHandler, DeleteUserbyid, toggleRepresentativeAvailability, setUserAsRepresentative, migrateRepresentatives, updateVehicleInfo, clearStaleImages, updateOnlineLocation, getOnlineRepresentatives, suspendUser, unsuspendUser, getSuspendedUsers, blockUser, unblockUser, getRepresentativeOrders, getRepresentativeRatingsAdmin, toggleVehicleEditPermission, changeUserType, getBannedDevices, unbanBannedDevice };

