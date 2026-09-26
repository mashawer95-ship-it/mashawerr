const asyncHandler = require('express-async-handler');
const joi = require('joi');
const { ORDER_STATUSES } = require('../constants/orderTypes');
const {
    Order,
    getNextTaskId,
    validateCreateOrder,
    validateCancelOrder,
} = require('../middlewares/Order');
const { User } = require('../middlewares/User');
// StoreOrder removed – delivery-only
const { RepTargetAchievement } = require('../middlewares/RepTarget');
const {
    assertUserCanUseDiscountCode,
    assertUserCanUseGlobalDiscount,
    consumeDiscountAfterSuccessfulOrder,
} = require('../middlewares/Discount');

const { buildUrl } = require('../config/urlBuilder');
const { notifyClient } = require('../services/notifyClient');
const { calculateRoute } = require('../services/googleRoutesService');
const { getOrCreatePricing, kdToFils } = require('../middlewares/Pricing');
const { redisGet, redisSet } = require('../config/redis');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const crypto = require('crypto');
const Redis = require('ioredis');
const zlib = require('zlib');
const util = require('util');
const gzipAsync = util.promisify(zlib.gzip);
const gunzipAsync = util.promisify(zlib.gunzip);
const { getCachedRepCommission, calcRepEarnings } = require('../middlewares/RepCommission');
const { checkAndRewardTarget } = require('../utils/targetRewardHelper');
const { sanitizeErrorResponse, isOwnerOrAuthorized } = require('../middlewares/objectAuthorization');

/** Returns null for stale Render-local image URLs that no longer exist. */
function sanitizeImageUrl(url) {
    if (!url) return null;
    if (url.includes('onrender.com/uploads/')) return null;
    return url;
}

/**
 * Batch-fetch all unique representatives referenced by the orders list
 * and merge their profile data into each formatted order.
 * Uses a single DB query regardless of how many orders are returned.
 */
async function enrichOrdersWithRepData(req, formattedOrders) {
    const repIds = [...new Set(
        formattedOrders
            .map((o) => o.representativeId)
            .filter(Boolean)
    )];
    if (repIds.length === 0) return formattedOrders;

    try {
        const mongoose = require('mongoose');
        const objectIds = repIds
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id));

        const reps = await User.find({ _id: { $in: objectIds } })
            .select('firstName lastName phone profileImage vehicleNumber vehicleColor vehicleModel vehicleImage email userType isAvailable createdAt lastLocation')
            .lean();

        // ─── Calculate Completed Orders & Ratings for each Rep ───
        const { UserRating } = require('../middlewares/UserRating');
        const { getDriverLocation } = require('../redis/trackingRedis');

        // Batch count completed orders for these representatives (trips)
        const completedCounts = await Order.aggregate([
            {
                $match: {
                    representativeId: { $in: repIds },
                    status: { $in: ['completed', 'delivered'] }
                }
            },
            {
                $group: {
                    _id: '$representativeId',
                    count: { $sum: 1 }
                }
            }
        ]);
        const tripsMap = {};
        completedCounts.forEach((c) => {
            if (c._id) tripsMap[c._id.toString()] = c.count;
        });

        // Batch calculate rating average & count for these representatives
        const ratingAggs = await UserRating.aggregate([
            {
                $match: {
                    rateeId: { $in: repIds },
                    rateeType: 'representative'
                }
            },
            {
                $group: {
                    _id: '$rateeId',
                    avgRating: { $avg: '$rating' },
                    ratingCount: { $sum: 1 }
                }
            }
        ]);
        const ratingMap = {};
        ratingAggs.forEach((r) => {
            if (r._id) {
                ratingMap[r._id.toString()] = {
                    avgRating: Math.round(r.avgRating * 10) / 10,
                    ratingCount: r.ratingCount
                };
            }
        });

        // Map repId -> repData
        const repMap = {};
        for (const rep of reps) {
            const repIdStr = rep._id.toString();
            const rInfo = ratingMap[repIdStr] || { avgRating: 4.9, ratingCount: 0 };
            const tripsCount = tripsMap[repIdStr] || 0;

            let liveLat = null;
            let liveLng = null;
            try {
                const redisLoc = await getDriverLocation(repIdStr);
                if (redisLoc && redisLoc.lat != null && redisLoc.lng != null) {
                    liveLat = redisLoc.lat;
                    liveLng = redisLoc.lng;
                }
            } catch (_) { }

            if (liveLat == null && rep.lastLocation && rep.lastLocation.lat != null && rep.lastLocation.lng != null) {
                liveLat = rep.lastLocation.lat;
                liveLng = rep.lastLocation.lng;
            }

            repMap[repIdStr] = {
                representativeId: repIdStr,
                driverId: repIdStr,
                representativeLatitude: liveLat,
                representativeLongitude: liveLng,
                driverLatitude: liveLat,
                driverLongitude: liveLng,
                representativeName: `${rep.firstName || ''} ${rep.lastName || ''}`.trim() || null,
                representativePhone: rep.phone || null,
                representativeEmail: rep.email || null,
                representativeProfileImage: sanitizeImageUrl(buildUrl(req, rep.profileImage)),
                representativeUserType: rep.userType || null,
                representativeIsAvailable: rep.isAvailable ?? null,
                representativeJoinedAt: rep.createdAt || null,
                vehicleNumber: rep.vehicleNumber || null,
                vehicleColor: rep.vehicleColor || null,
                vehicleModel: rep.vehicleModel || null,
                vehicleImage: sanitizeImageUrl(buildUrl(req, rep.vehicleImage)),

                // 🌟 Return trips count & rating for customer view
                driverRating: rInfo.avgRating,
                driverRatingCount: tripsCount > 0 ? tripsCount : rInfo.ratingCount,
                representativeRating: rInfo.avgRating,
                representativeTripsCount: tripsCount,
            };
        }

        return formattedOrders.map((o) => ({
            ...o,
            ...(o.representativeId ? (repMap[o.representativeId] || {}) : {}),
        }));
    } catch (err) {
        console.error('[enrichOrdersWithRepData] Failed:', err.message);
        return formattedOrders; // fallback: ارجع الأوردرات بدون بيانات المندوب
    }
}

/**
 * Batch-fetch client profile data and merge into each formatted order.
 */
async function enrichOrdersWithClientData(req, formattedOrders) {
    const clientIds = [...new Set(
        formattedOrders
            .map((o) => o.clientId)
            .filter(Boolean)
    )];

    try {
        const clientMap = {};
        if (clientIds.length > 0) {
            const mongoose = require('mongoose');
            const objectIds = clientIds
                .filter((id) => mongoose.Types.ObjectId.isValid(id))
                .map((id) => new mongoose.Types.ObjectId(id));

            if (objectIds.length > 0) {
                const clients = await User.find({ _id: { $in: objectIds } })
                    .select('firstName lastName phone profileImage governorate')
                    .lean();

                for (const c of clients) {
                    clientMap[c._id.toString()] = {
                        clientName: `${c.firstName || ''} ${c.lastName || ''}`.trim() || null,
                        clientPhoneNumber: c.phone || null,
                        clientPhotoUrl: sanitizeImageUrl(buildUrl(req, c.profileImage)),
                        governorate: c.governorate || null,
                        clientGovernorate: c.governorate || null,
                    };
                }
            }
        }

        return formattedOrders.map((o) => {
            const cData = o.clientId ? (clientMap[o.clientId.toString()] || {}) : {};

            const rawName = cData.clientName || o.clientName || (o.userInfo ? `${o.userInfo.firstName || ''} ${o.userInfo.lastName || ''}`.trim() : null);
            const clientName = (rawName && rawName !== 'عميل محذوف' && String(rawName).trim().length > 0) ? String(rawName).trim() : (o.clientName && o.clientName !== 'عميل محذوف' ? o.clientName : 'عميل');

            const clientPhoneNumber = cData.clientPhoneNumber || o.clientPhoneNumber || o.userInfo?.phone || o.customerPhone || null;
            const clientPhotoUrl = cData.clientPhotoUrl || o.clientPhotoUrl || (o.userInfo?.profileImage ? sanitizeImageUrl(buildUrl(req, o.userInfo.profileImage)) : null) || null;
            const clientGov = cData.clientGovernorate || o.userInfo?.governorate || o.governorate || null;

            return {
                ...o,
                clientName,
                clientPhoneNumber,
                clientPhotoUrl,
                clientGovernorate: clientGov,
                governorate: clientGov,
            };
        });
    } catch (err) {
        console.error('[enrichOrdersWithClientData] Failed:', err.message);
        return formattedOrders;
    }
}

/**
 * Batch-fetch vehicle type names for orders with vehicleTypeId but missing vehicleName.
 */
async function enrichOrdersWithVehicleData(req, formattedOrders) {
    const vehicleTypeIds = [...new Set(
        formattedOrders
            .filter((o) => o.vehicleTypeId && (!o.vehicleName || !o.vehicleTypeName))
            .map((o) => o.vehicleTypeId)
    )];
    if (vehicleTypeIds.length === 0) return formattedOrders;

    try {
        const { VehicleType } = require('../middlewares/VehicleType');
        const mongoose = require('mongoose');
        const validObjectIds = vehicleTypeIds
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
            .map((id) => new mongoose.Types.ObjectId(id));

        const vehicleTypes = await VehicleType.find({ _id: { $in: validObjectIds } }).lean();
        const vMap = {};
        for (const vt of vehicleTypes) {
            vMap[vt._id.toString()] = vt.name_ar || vt.name_en || null;
        }

        return formattedOrders.map((o) => {
            if (o.vehicleTypeId && (!o.vehicleName || !o.vehicleTypeName) && vMap[o.vehicleTypeId]) {
                const name = vMap[o.vehicleTypeId];
                return {
                    ...o,
                    vehicleName: o.vehicleName || name,
                    vehicleTypeName: o.vehicleTypeName || name,
                };
            }
            return o;
        });
    } catch (err) {
        console.error('[enrichOrdersWithVehicleData] Failed:', err.message);
        return formattedOrders;
    }
}

/** Legacy DB had numeric status; normalize for responses. */
const LEGACY_STATUS_MAP = { 0: 'waiting', 1: 'accepted', 2: 'completed', 3: 'cancelled' };

function normalizeOrderStatus(raw) {
    if (raw == null || raw === '') return 'waiting';
    if (typeof raw === 'number') return LEGACY_STATUS_MAP[raw] ?? 'waiting';
    if (ORDER_STATUSES.includes(raw)) return raw;
    return 'waiting';
}

/** Returns sanitized image URL, returning null only for empty or invalid values. */
function sanitizeImageUrl(url) {
    if (!url) return null;
    const str = String(url).trim();
    if (!str || str === 'null' || str === 'undefined') return null;
    return str;
}

function formatOrder(req, order, commissionCfg) {
    const status = normalizeOrderStatus(order.status);
    const tasksWithIds = (order.tasks || []).map((task) => {
        const t = typeof task.toObject === 'function' ? task.toObject() : { ...task };
        const rawBefore = t.itemPhotoBefore || t.ItemPhotoBefore || t.pickupPhoto || t.pickupPhotoUrl || t.photoBefore || null;
        const rawAfter = t.itemPhotoAfter || t.ItemPhotoAfter || t.deliveryPhoto || t.deliveryPhotoUrl || t.podPhoto || t.proofPhoto || t.photoAfter || null;

        const beforeUrl = rawBefore ? sanitizeImageUrl(buildUrl(req, rawBefore)) : null;
        const afterUrl = rawAfter ? sanitizeImageUrl(buildUrl(req, rawAfter)) : null;

        return {
            ...t,
            taskId: t.taskId,
            itemPhotoBefore: beforeUrl,
            itemPhotoAfter: afterUrl,
            pickupPhoto: beforeUrl,
            deliveryPhoto: afterUrl,
            pickupPhotoUrl: beforeUrl,
            deliveryPhotoUrl: afterUrl,
        };
    });

    const hasDiscount = order.discountAmount > 0;
    const vName = order.vehicleName || order.vehicleTypeName || null;

    const deliveryPriceKD = order.totalDeliveryPrice ? Number((order.totalDeliveryPrice / 1000).toFixed(3)) : 0;
    const deliveryPct = commissionCfg?.deliveryRepCommissionPct ?? 100;
    const repEarnings = calcRepEarnings(deliveryPriceKD, deliveryPct);

    const rootPickupRaw = order.pickupPhoto || order.pickupPhotoUrl || order.itemPhotoBefore || (tasksWithIds[0] ? (tasksWithIds[0].itemPhotoBefore || tasksWithIds[0].pickupPhoto) : null);
    const rootDeliveryRaw = order.deliveryPhoto || order.deliveryPhotoUrl || order.itemPhotoAfter || order.podPhoto || order.proofPhoto || (tasksWithIds[0] ? (tasksWithIds[0].itemPhotoAfter || tasksWithIds[0].deliveryPhoto) : null);

    const pickupPhotoUrl = rootPickupRaw ? sanitizeImageUrl(buildUrl(req, rootPickupRaw)) : null;
    const deliveryPhotoUrl = rootDeliveryRaw ? sanitizeImageUrl(buildUrl(req, rootDeliveryRaw)) : null;

    return {
        orderId: order.orderId,
        clientId: order.clientId,
        representativeId: order.representativeId || null,
        vehicleTypeId: order.vehicleTypeId || null,
        vehicleName: vName,
        vehicleTypeName: vName,
        // ─── بيانات السعر والخصم ──────────────────────
        originalDeliveryPrice: hasDiscount && (order.originalDeliveryPrice ?? order.totalDeliveryPrice)
            ? Number(((order.originalDeliveryPrice ?? order.totalDeliveryPrice) / 1000).toFixed(3))
            : null,
        totalDeliveryPrice: deliveryPriceKD,
        discountAmount: order.discountAmount ? Number((order.discountAmount / 1000).toFixed(3)) : 0,
        discountPercentage: order.discountPercentage ?? null,
        discountCode: order.discountCode || null,
        discountType: order.discountType || null,
        // ─── أرباح المندوب (نسبة من سعر التوصيل) ──────
        repEarnings,
        deliveryRepCommissionPct: deliveryPct,
        // ──────────────────────────────────────────────────────────────────────────────────
        totalPrice: order.totalPrice != null
            ? Number((order.totalPrice > 100 ? order.totalPrice / 1000 : order.totalPrice).toFixed(3))
            : 0,
        totalDistanceKm: calculateOrderTripDistance(order),
        distanceKm: calculateOrderTripDistance(order),
        status,
        orderType: order.orderType || null,
        orderCategory: order.orderCategory || 'delivery',
        paymentMethod: order.paymentMethod || 'cash',
        representativeWillPay: Boolean(order.representativeWillPay),
        representativePaymentAmount: order.representativePaymentAmount || 0,
        purchaseDetails: order.purchaseDetails || null,
        isBusinessOrder: false,
        isStoreOrder: false,
        cancellationReason: order.cancellationReason || null,
        reviewReason: order.reviewReason || null,
        returnReason: order.returnReason || order.returnDetails?.reason || null,
        returnDetails: order.returnDetails || null,
        isReturnOrder: Boolean(order.isReturnOrder || order.status === 'returned' || (typeof order.status === 'string' && order.status.startsWith('return_'))),
        pickupPhoto: pickupPhotoUrl,
        deliveryPhoto: deliveryPhotoUrl,
        pickupPhotoUrl: pickupPhotoUrl,
        deliveryPhotoUrl: deliveryPhotoUrl,
        itemPhotoBefore: pickupPhotoUrl,
        itemPhotoAfter: deliveryPhotoUrl,
        tasks: tasksWithIds,
        allLocationsInOrder: order.allLocationsInOrder || [],
        acceptedAt: order.acceptedAt ? (order.acceptedAt instanceof Date ? order.acceptedAt.toISOString() : String(order.acceptedAt)) : null,
        arrivalConfirmedAt: order.arrivalConfirmedAt ? (order.arrivalConfirmedAt instanceof Date ? order.arrivalConfirmedAt.toISOString() : String(order.arrivalConfirmedAt)) : null,
        arrivalTimerExpiredAt: order.arrivalTimerExpiredAt ? (order.arrivalTimerExpiredAt instanceof Date ? order.arrivalTimerExpiredAt.toISOString() : String(order.arrivalTimerExpiredAt)) : null,
        isClientDelayed: order.isClientDelayed || false,
        delayedAt: order.delayedAt ? (order.delayedAt instanceof Date ? order.delayedAt.toISOString() : String(order.delayedAt)) : null,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
    };
}


/**
 * @description List orders (optional filter by status and/or clientId)
 * @route GET /api/orders?status=waiting|accepted|completed|cancelled|deleted&clientId=
 * @access Public
 */
const listOrders = asyncHandler(async (req, res) => {
    const { error, value } = joi
        .object({
            status: joi.string().trim().optional().allow(''),
            clientId: joi.string().trim().optional().allow(''),
            date: joi.string().trim().optional().allow(''),
            dateTime: joi.string().trim().optional().allow(''),
            address: joi.string().trim().optional().allow(''),
            orderStatus: joi.number().optional().allow(null), // 0=pending/waiting, 1=accepted/review, 2=cancelled, 3=completed
            orderType: joi.string().trim().optional().allow(''), // فلتر نوع الأوردر (delivery, store, etc.)
            governorate: joi.string().trim().optional().allow(''), // فلتر المحافظة
            page: joi.number().integer().min(1).default(1),
            limit: joi.number().integer().min(1).max(100).default(20),
        })
        .validate(req.query, { abortEarly: false, stripUnknown: true });

    if (error) {
        return res.status(400).json({
            message: error.details.map((d) => d.message).join('; '),
        });
    }

    const filter = {};

    // ── Status filtering ──
    if (value.orderStatus !== undefined && value.orderStatus !== null) {
        const statusMap = {
            0: 'waiting',
            1: { $in: ['accepted', 'delivering', 'confirmed', 'processing'] },
            2: { $in: ['cancelled', 'return_cancelled'] },
            3: { $in: ['completed', 'delivered'] },
            4: 'review',
            5: 'delayed',
            6: { $in: ['return_pending', 'return_accepted', 'return_delivering'] },
            7: 'returned',
        };
        if (statusMap[value.orderStatus] !== undefined) {
            filter.status = statusMap[value.orderStatus];
        }
    } else if (value.status && value.status.toLowerCase() !== 'all') {
        const s = value.status.toLowerCase();
        if (s === 'pending' || s === 'waiting') {
            filter.status = 'waiting';
        } else if (s === 'review') {
            filter.status = 'review';
        } else if (s === 'delayed') {
            filter.status = 'delayed';
        } else if (s === 'accepted' || s === 'inprogress') {
            filter.status = { $in: ['accepted', 'delivering', 'confirmed', 'processing'] };
        } else if (s === 'completed' || s === 'delivered') {
            filter.status = { $in: ['completed', 'delivered'] };
        } else if (s === 'cancelled') {
            filter.status = { $in: ['cancelled', 'return_cancelled'] };
        } else if (s === 'return_pending' || s === 'returning' || s === 'returns') {
            filter.status = { $in: ['return_pending', 'return_accepted', 'return_delivering'] };
        } else if (s === 'returned') {
            filter.status = 'returned';
        } else {
            filter.status = value.status;
        }
    }

    // ── Delivery orders ONLY (exclude business/store orders) ──
    filter.isBusinessOrder = { $ne: true };

    if (value.clientId) filter.clientId = value.clientId;
    if (value.orderType) filter.orderType = value.orderType;

    // ── Date filtering ──
    const dateParam = value.dateTime || value.date;
    if (dateParam) {
        const startDate = new Date(dateParam);
        if (!isNaN(startDate.getTime())) {
            startDate.setHours(0, 0, 0, 0);
            const endDate = new Date(startDate);
            endDate.setDate(endDate.getDate() + 1);
            filter.createdAt = { $gte: startDate, $lt: endDate };
        }
    }

    if (value.address) {
        // Search in pickup or delivery location
        filter.$or = [
            { 'tasks.pickupLocation.streetName': { $regex: value.address, $options: 'i' } },
            { 'tasks.deliveryLocation.streetName': { $regex: value.address, $options: 'i' } }
        ];
    }

    if (value.governorate && value.governorate.trim()) {
        const govTerm = value.governorate.trim();
        const matchingUsers = await User.find({
            governorate: { $regex: new RegExp(govTerm, 'i') }
        }).select('_id phone').lean();
        const userIds = matchingUsers.map((u) => u._id.toString());
        const userPhones = matchingUsers.map((u) => u.phone).filter(Boolean);
        const govConditions = [
            { clientId: { $in: userIds } },
            { userId: { $in: userIds } },
        ];
        if (userPhones.length > 0) {
            govConditions.push({ clientId: { $in: userPhones } });
            govConditions.push({ userId: { $in: userPhones } });
        }
        if (filter.$or) {
            filter.$and = [
                { $or: filter.$or },
                { $or: govConditions }
            ];
            delete filter.$or;
        } else {
            filter.$or = govConditions;
        }
    }

    const pageNum = Math.max(1, parseInt(value.page || 1));
    const limitNum = Math.min(100, Math.max(1, parseInt(value.limit || 20)));
    const skip = (pageNum - 1) * limitNum;

    const commissionCfg = await getCachedRepCommission().catch(() => null);
    const [orders, total] = await Promise.all([
        Order.find(filter).sort({ orderId: -1 }).skip(skip).limit(limitNum).lean(),
        Order.countDocuments(filter)
    ]);

    let formatted = await enrichOrdersWithRepData(req, orders.map((o) => formatOrder(req, o, commissionCfg)));
    formatted = await enrichOrdersWithClientData(req, formatted);
    formatted = await enrichOrdersWithVehicleData(req, formatted);
    formatted = await enrichOrdersWithDeliveryPhotos(req, formatted);

    const totalPages = Math.ceil(total / limitNum);
    res.setHeader('X-Total-Count', total);

    return res.status(200).json({
        orders: formatted,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages,
    });
});

/**
 * @description All orders for a user (by MongoDB user id = clientId), every status
 * @route GET /api/orders/user/:userId
 * @access Public
 */
const listOrdersByUserId = asyncHandler(async (req, res) => {
    const userId = (req.params.userId || '').trim();
    const { error } = joi
        .string()
        .trim()
        .min(1)
        .max(64)
        .required()
        .messages({ 'string.empty': 'userId is required' })
        .validate(userId);

    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (req.user?.id?.toString() !== userId && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const commissionCfg = await getCachedRepCommission().catch(() => null);
    const mongoose = require('mongoose');
    const userObjId = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : null;

    const deliveryFilter = {
        $or: [
            { clientId: String(userId) },
            ...(userObjId ? [{ clientId: userObjId }] : []),
            { userId: String(userId) },
            ...(userObjId ? [{ userId: userObjId }] : []),
        ],
        isBusinessOrder: { $ne: true },
        orderCategory: { $ne: 'business' },
    };

    const orders = await Order.find(deliveryFilter)
        .sort({ createdAt: -1, orderId: -1 })
        .lean();

    const formattedList = orders
        .map((doc) => formatOrder(req, doc, commissionCfg))
        .filter(Boolean);

    let enriched = await enrichOrdersWithRepData(req, formattedList);
    enriched = await enrichOrdersWithClientData(req, enriched);
    enriched = await enrichOrdersWithVehicleData(req, enriched);
    enriched = await enrichOrdersWithDeliveryPhotos(req, enriched);
    enriched.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return res.status(200).json(enriched);
});


async function enrichOrdersWithDeliveryPhotos(req, formattedOrders) {
    if (!Array.isArray(formattedOrders) || formattedOrders.length === 0) {
        return formattedOrders;
    }

    try {
        const { DeliveryAttempt } = require('../models/DeliveryAttempt');
        const { DeliverySession } = require('../models/DeliverySession');

        const rawOrderIds = formattedOrders.map((o) => o.id || o.orderId || o._id).filter(Boolean);
        if (rawOrderIds.length === 0) return formattedOrders;

        const orderIdsToQuery = [];
        rawOrderIds.forEach((id) => {
            orderIdsToQuery.push(id);
            const strId = String(id);
            if (!orderIdsToQuery.includes(strId)) orderIdsToQuery.push(strId);
            const numId = Number(id);
            if (!isNaN(numId) && !orderIdsToQuery.includes(numId)) orderIdsToQuery.push(numId);
        });

        const sessions = await DeliverySession.find({ orderId: { $in: orderIdsToQuery } }).lean();

        if (sessions.length > 0) {
            const sessionIds = sessions.map((s) => s.sessionId);
            const attempts = await DeliveryAttempt.find({ sessionId: { $in: sessionIds } })
                .sort({ attemptNumber: 1 })
                .lean();

            const sessionToPickupPhotosMap = {};
            const sessionToDeliveryPhotosMap = {};

            attempts.forEach((a) => {
                let photoUrl = null;
                if (a.photo?.cdnUrl) {
                    photoUrl = a.photo.cdnUrl;
                } else if (a.photo?.objectKey) {
                    photoUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${a.photo.objectKey}`;
                } else if (a.photoUrl) {
                    photoUrl = buildUrl(req, a.photoUrl);
                } else if (a.photo && typeof a.photo === 'string') {
                    photoUrl = buildUrl(req, a.photo);
                } else if (a.image && typeof a.image === 'string') {
                    photoUrl = buildUrl(req, a.image);
                }

                if (photoUrl) {
                    photoUrl = sanitizeImageUrl(photoUrl);
                    if (photoUrl) {
                        const isPickup = (a.phase === 'PICKUP');
                        if (isPickup) {
                            if (!sessionToPickupPhotosMap[a.sessionId]) {
                                sessionToPickupPhotosMap[a.sessionId] = [];
                            }
                            if (!sessionToPickupPhotosMap[a.sessionId].includes(photoUrl)) {
                                sessionToPickupPhotosMap[a.sessionId].push(photoUrl);
                            }
                        } else {
                            if (!sessionToDeliveryPhotosMap[a.sessionId]) {
                                sessionToDeliveryPhotosMap[a.sessionId] = [];
                            }
                            if (!sessionToDeliveryPhotosMap[a.sessionId].includes(photoUrl)) {
                                sessionToDeliveryPhotosMap[a.sessionId].push(photoUrl);
                            }
                        }
                    }
                }
            });

            const orderToPickupPhotosMap = {};
            const orderToDeliveryPhotosMap = {};

            sessions.forEach((s) => {
                if (s.orderId) {
                    const key = s.orderId.toString();
                    if (sessionToPickupPhotosMap[s.sessionId]) {
                        orderToPickupPhotosMap[key] = (orderToPickupPhotosMap[key] || []).concat(sessionToPickupPhotosMap[s.sessionId]);
                    }
                    if (sessionToDeliveryPhotosMap[s.sessionId]) {
                        orderToDeliveryPhotosMap[key] = (orderToDeliveryPhotosMap[key] || []).concat(sessionToDeliveryPhotosMap[s.sessionId]);
                    }
                }
            });

            return formattedOrders.map((o) => {
                const oid = (o.id || o.orderId || o._id || '').toString();
                const sessionPickupList = orderToPickupPhotosMap[oid] || [];
                const sessionDeliveryList = orderToDeliveryPhotosMap[oid] || [];

                const sessionPickupPhoto = sessionPickupList[0] || null;
                const sessionDeliveryPhoto = sessionDeliveryList[0] || null;

                const pPhoto = o.pickupPhoto || o.pickupPhotoUrl || o.itemPhotoBefore || sessionPickupPhoto || null;
                const dPhoto = o.deliveryPhoto || o.deliveryPhotoUrl || o.itemPhotoAfter || sessionDeliveryPhoto || null;

                const isSingleTask = (o.tasks || []).length <= 1;

                const tasks = (o.tasks || []).map((t, idx) => {
                    const podP = sessionPickupList[idx] || null;
                    const podD = sessionDeliveryList[idx] || null;

                    const taskPickup = t.itemPhotoBefore || t.pickupPhoto || t.pickupPhotoUrl || podP || (isSingleTask ? pPhoto : null);
                    const taskDelivery = t.itemPhotoAfter || t.deliveryPhoto || t.deliveryPhotoUrl || t.podPhoto || t.proofPhoto || podD || (isSingleTask ? dPhoto : null);

                    return {
                        ...t,
                        itemPhotoBefore: taskPickup,
                        itemPhotoAfter: taskDelivery,
                        pickupPhoto: taskPickup,
                        deliveryPhoto: taskDelivery,
                        pickupPhotoUrl: taskPickup,
                        deliveryPhotoUrl: taskDelivery,
                    };
                });

                const isSingleItem = (o.items || []).length <= 1;

                const items = (o.items || []).map((item, idx) => {
                    const podP = sessionPickupList[idx] || null;
                    const podD = sessionDeliveryList[idx] || null;

                    const itemPickup = item.pickupPhoto || item.pickupPhotoUrl || item.itemPhotoBefore || podP || (isSingleItem ? pPhoto : null);
                    const itemDelivery = item.deliveryPhoto || item.deliveryPhotoUrl || item.itemPhotoAfter || podD || (isSingleItem ? dPhoto : null);

                    return {
                        ...item,
                        itemPhotoBefore: itemPickup,
                        itemPhotoAfter: itemDelivery,
                        pickupPhoto: itemPickup,
                        deliveryPhoto: itemDelivery,
                        pickupPhotoUrl: itemPickup,
                        deliveryPhotoUrl: itemDelivery,
                    };
                });

                const pickupPhotos = Array.from(new Set([
                    ...(o.pickupPhotos || []),
                    ...sessionPickupList,
                    pPhoto,
                    ...tasks.map(t => t.pickupPhoto),
                    ...items.map(i => i.pickupPhoto),
                ].filter(Boolean)));

                const deliveryPhotos = Array.from(new Set([
                    ...(o.deliveryPhotos || []),
                    ...sessionDeliveryList,
                    dPhoto,
                    ...tasks.map(t => t.deliveryPhoto),
                    ...items.map(i => i.deliveryPhoto),
                ].filter(Boolean)));

                return {
                    ...o,
                    pickupPhoto: pPhoto,
                    deliveryPhoto: dPhoto,
                    pickupPhotoUrl: pPhoto,
                    deliveryPhotoUrl: dPhoto,
                    itemPhotoBefore: pPhoto,
                    itemPhotoAfter: dPhoto,
                    pickupPhotos,
                    deliveryPhotos,
                    tasks,
                    items,
                };
            });
        }
    } catch (err) {
        console.error('[enrichOrdersWithDeliveryPhotos] Failed:', err.message);
    }
    return formattedOrders;
}

/**
 * @description All orders handled by a representative (by MongoDB user id = representativeId), every status
 * @route GET /api/orders/representative/:repId
 * @access Public (representative)
 */
const listOrdersByRepresentativeId = asyncHandler(async (req, res) => {
    const repId = (req.params.repId || '').trim();
    const { error } = joi
        .string()
        .trim()
        .min(1)
        .max(64)
        .required()
        .messages({ 'string.empty': 'repId is required' })
        .validate(repId);

    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (req.user?.id?.toString() !== repId && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const orders = await Order.find({
        representativeId: repId,
        isBusinessOrder: { $ne: true },
        orderCategory: { $ne: 'business' },
    }).sort({ orderId: -1 }).lean();

    // ─── جلب بيانات المندوب مرة واحدة وإدراجها في كل الأوردرات ──────────────
    let repData = null;
    try {
        const mongoose = require('mongoose');
        const objectId = new mongoose.Types.ObjectId(repId);
        const rep = await User.findOne({ _id: objectId })
            .select('firstName lastName phone profileImage vehicleNumber vehicleColor vehicleModel vehicleImage email userType isAvailable createdAt')
            .lean();

        if (rep) {
            repData = {
                representativeName: `${rep.firstName || ''} ${rep.lastName || ''}`.trim() || null,
                representativePhone: rep.phone || null,
                representativeEmail: rep.email || null,
                representativeProfileImage: sanitizeImageUrl(buildUrl(req, rep.profileImage)),
                representativeUserType: rep.userType || null,
                representativeIsAvailable: rep.isAvailable ?? null,
                representativeJoinedAt: rep.createdAt || null,
                vehicleNumber: rep.vehicleNumber || null,
                vehicleColor: rep.vehicleColor || null,
                vehicleModel: rep.vehicleModel || null,
                vehicleImage: sanitizeImageUrl(buildUrl(req, rep.vehicleImage)),
            };
        } else {
            console.warn(`[listOrdersByRepresentativeId] No user found for repId=${repId}`);
        }
    } catch (lookupErr) {
        console.error(`[listOrdersByRepresentativeId] Failed to fetch rep profile for ${repId}:`, lookupErr.message);
    }

    const commissionCfg = await getCachedRepCommission().catch(() => null);

    const formattedOrders = orders.map((o) => ({
        ...formatOrder(req, o, commissionCfg),
        ...(repData || {}),
    }));

    formattedOrders.sort((a, b) => {
        const dateA = new Date(a.createdAt || 0);
        const dateB = new Date(b.createdAt || 0);
        return dateB - dateA;
    });

    let finalFormatted = await enrichOrdersWithClientData(req, formattedOrders);
    finalFormatted = await enrichOrdersWithVehicleData(req, finalFormatted);
    finalFormatted = await enrichOrdersWithDeliveryPhotos(req, finalFormatted);
    return res.status(200).json(finalFormatted);
});






/**
 * @description Create a new order
 * @route POST /api/orders
 * @access Public
 */
const createOrder = asyncHandler(async (req, res) => {
    // â”€â”€â”€ Idempotency Check â”€â”€â”€
    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey) {
        const cachedOrder = await redisGet(`idempotency:order:${idempotencyKey}`);
        if (cachedOrder) {
            return res.status(201).json(cachedOrder);
        }
    }

    // Automatically assign clientId from authenticated user if not provided in request body
    if (!req.body.clientId && req.user?.id) {
        req.body.clientId = req.user.id.toString();
    }

    const { error, value } = validateCreateOrder(req.body);
    if (error) {
        return res.status(400).json({
            message: error.details.map((d) => d.message).join('; '),
        });
    }

    // Force identity to req.user.id to prevent IDOR / spoofed client creation
    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (!isAdmin || !value.clientId) {
        value.clientId = req.user?.id?.toString() || value.clientId;
    }

    if (!value.clientId) {
        return res.status(400).json({ message: 'clientId is required' });
    }

    // ─── فحص محفظة العميل: يمنع الإنشاء إذا كان الرصيد أقل من الحد الأدنى المسموح به ───────────
    try {
        const { checkWalletCanOrder } = require('../middlewares/Wallet');
        const checkUserId = value.clientId || req.user?.id || req.user?._id;
        const walletCheck = await checkWalletCanOrder(checkUserId);
        if (!walletCheck.canOrder) {
            return res.status(402).json({
                code: 'WALLET_NEGATIVE_BALANCE',
                message: walletCheck.message,
                balanceFils: walletCheck.balanceFils,
                balanceKWD: walletCheck.balanceKWD,
                minBalanceFils: walletCheck.minBalanceFils,
                minBalanceKWD: walletCheck.minBalanceKWD,
            });
        }
    } catch (walletCheckErr) {
        logger.error(`[createOrder] Wallet check error: ${walletCheckErr.message}`);
    }

    // ─── فحص الحد الأقصى للطلبات النشطة (طلبين كحد أقصى للعميل) ───────────
    if (!isAdmin) {
        const activeStatuses = [
            'waiting',
            'accepted',
            'delivering',
            'confirmed',
            'processing',
            'shipped',
            'pending',
        ];
        const activeCount = await Order.countDocuments({
            $or: [{ clientId: value.clientId }, { userId: value.clientId }],
            status: { $in: activeStatuses },
        });

        if (activeCount >= 2) {
            return res.status(400).json({
                code: 'MAX_ACTIVE_ORDERS_REACHED',
                message: 'لقد وصلت إلى الحد الأقصى للطلبات النشطة (طلبين كحد أقصى)',
                activeCount,
                maxAllowed: 2,
            });
        }
    }

    const amt = Number(value.discountAmount) || 0;
    const dtype = value.discountType ? String(value.discountType).trim() : '';
    if (amt > 0 && (dtype === 'percentage' || dtype === 'fixed') && value.discountCode) {
        const check = await assertUserCanUseDiscountCode(value.clientId, value.discountCode);
        if (!check.ok) {
            return res.status(check.status).json({ message: check.message });
        }
    } else if (amt > 0 && dtype === 'global_discount') {
        const check = await assertUserCanUseGlobalDiscount(value.clientId);
        if (!check.ok) {
            return res.status(check.status).json({ message: check.message });
        }
    }

    const tasks = [];
    for (const task of value.tasks) {
        tasks.push({
            ...task,
            taskId: await getNextTaskId(),
        });
    }

    // â”€â”€â”€ Single Source of Truth: Google Routes â”€â”€â”€
    let routeStatus = 'FAILED';
    let routeSnapshot = {
        schemaVersion: 1,
        encodedPolyline: null,
        compression: 'none',
        routeChecksum: null,
        distanceMeters: 0,
        durationSeconds: 0,
        routeCreatedAt: new Date(),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        polylineQuality: 'HIGH_QUALITY',
        polylineEncoding: 'ENCODED_POLYLINE',
        provider: 'google',
        providerVersion: 'v2'
    };

    let backendDeliveryPriceFils = 0;
    let pricingVersion = 1;
    let distanceMeters = 0; // Total distance for pricing (sum of individual tasks)
    let fullRouteDistanceMeters = 0; // Distance of the continuous route for the driver

    // 1. Generate full continuous route for the driver's map
    const waypoints = [];
    const rawAllLocs = req.body.allLocationsInOrder || value.allLocationsInOrder;
    if (Array.isArray(rawAllLocs) && rawAllLocs.length >= 2) {
        rawAllLocs.forEach((loc) => {
            const lat = Number(loc.lat ?? loc.latitude ?? (loc.latLng && (loc.latLng.lat ?? loc.latLng.latitude)));
            const lng = Number(loc.lng ?? loc.longitude ?? (loc.latLng && (loc.latLng.lng ?? loc.latLng.longitude)));
            if (lat && lng && !(lat === 0 && lng === 0)) {
                const lastWp = waypoints[waypoints.length - 1];
                if (!lastWp || lastWp.lat !== lat || lastWp.lng !== lng) {
                    waypoints.push({ lat, lng });
                }
            }
        });
    }

    if (waypoints.length < 2) {
        const pickupWps = [];
        const dropoffWps = [];
        tasks.forEach((task) => {
            if (task.fromLatitude && task.fromLongitude) {
                const lastWp = pickupWps[pickupWps.length - 1];
                if (!lastWp || lastWp.lat !== task.fromLatitude || lastWp.lng !== task.fromLongitude) {
                    pickupWps.push({ lat: task.fromLatitude, lng: task.fromLongitude });
                }
            }
            if (task.toLatitude && task.toLongitude) {
                const lastWp = dropoffWps[dropoffWps.length - 1];
                if (!lastWp || lastWp.lat !== task.toLatitude || lastWp.lng !== task.toLongitude) {
                    dropoffWps.push({ lat: task.toLatitude, lng: task.toLongitude });
                }
            }
        });
        waypoints.push(...pickupWps, ...dropoffWps);
    }

    if (waypoints.length >= 2) {
        const origin = waypoints[0];
        const destination = waypoints[waypoints.length - 1];
        const intermediates = waypoints.slice(1, -1);
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), 8000); // 8s timeout

        const startTime = Date.now();
        try {
            // First: Calculate full route for the map display
            const routeData = await calculateRoute(origin, destination, {
                forceRefresh: true,
                signal: abortController.signal,
                intermediates
            });

            // Second: Calculate individual task distances for accurate pricing
            let totalTasksDistance = 0;
            const taskPromises = tasks.map(async (task) => {
                if (task.fromLatitude && task.fromLongitude && task.toLatitude && task.toLongitude) {
                    const tOrigin = { lat: task.fromLatitude, lng: task.fromLongitude };
                    const tDest = { lat: task.toLatitude, lng: task.toLongitude };
                    try {
                        const tRoute = await calculateRoute(tOrigin, tDest, { forceRefresh: true });
                        if (tRoute && tRoute.distanceMeters) {
                            return tRoute.distanceMeters;
                        }
                    } catch (e) {
                        logger.error(`[OrderController] Individual task route failed: ${e.message}`);
                    }
                }
                return 0;
            });

            const taskDistances = await Promise.all(taskPromises);
            totalTasksDistance = taskDistances.reduce((a, b) => a + b, 0);

            clearTimeout(timeoutId);
            const googleTime = Date.now() - startTime;
            metrics.timing('routeProviderResponseTime', googleTime);

            if (routeData && routeData.encodedPolyline) {
                fullRouteDistanceMeters = routeData.distanceMeters || 0;
                // Use the sum of individual task distances for pricing if available
                distanceMeters = totalTasksDistance > 0 ? totalTasksDistance : fullRouteDistanceMeters;

                routeSnapshot.distanceMeters = fullRouteDistanceMeters; // Driver sees full distance
                routeSnapshot.durationSeconds = routeData.durationSeconds || 0;

                if (routeData.legPolylines && routeData.legPolylines.length > 0) {
                    routeSnapshot.legPolylines = routeData.legPolylines;
                }

                // MD5 Checksum
                routeSnapshot.routeChecksum = crypto.createHash('md5').update(routeData.encodedPolyline).digest('hex');

                // Async Gzip Compression if > 8KB
                const polySize = Buffer.byteLength(routeData.encodedPolyline, 'utf8');
                if (polySize > 8192) {
                    const zipped = await gzipAsync(routeData.encodedPolyline);
                    routeSnapshot.encodedPolyline = zipped.toString('base64');
                    routeSnapshot.compression = 'gzip';
                } else {
                    routeSnapshot.encodedPolyline = routeData.encodedPolyline;
                    routeSnapshot.compression = 'none';
                }

                routeStatus = 'READY';
                logger.info('ORDER_ROUTE_CREATED', { orderClientId: value.clientId, distanceMeters, fullRouteDistanceMeters, googleTime });
            }
        } catch (err) {
            clearTimeout(timeoutId);
            logger.error(`[OrderController] Route generation failed for client ${value.clientId}: ${err.message}`);
        }
    }

    // ─── Secure Pricing Calculation ───
    try {
        let pricing;
        let pricingVersion = 1;

        if (value.vehicleTypeId) {
            const { VehicleType } = require('../middlewares/VehicleType');
            const mongoose = require('mongoose');
            if (mongoose.Types.ObjectId.isValid(value.vehicleTypeId)) {
                pricing = await VehicleType.findById(value.vehicleTypeId);
            }
        }

        if (!pricing) {
            const { getOrCreatePricing } = require('../middlewares/Pricing');
            pricing = await getOrCreatePricing();
        }

        pricingVersion = (pricing.$__ && pricing.$__.version) !== undefined ? pricing.$__.version : 1;

        // Use client-provided distance for pricing to ensure it matches what they saw in the cart EXACTLY
        const pricingDistanceMeters = (value.totalDistanceKm || 0) * 1000;

        const numTasks = Math.max(1, tasks.length);
        let calculatedKd = (pricing.baseFare * numTasks) + (pricingDistanceMeters * pricing.pricePerMeter);
        calculatedKd = calculatedKd * pricing.surgeMultiplier;

        if (calculatedKd < pricing.minFare) {
            calculatedKd = pricing.minFare;
        }

        const originalFils = kdToFils(calculatedKd);
        backendDeliveryPriceFils = originalFils;

        if (amt > 0) {
            if ((dtype === 'percentage' || dtype === 'global_discount') && (value.discountPercentage || 0) > 0) {
                const perc = value.discountPercentage || 0;
                const discountVal = (backendDeliveryPriceFils * perc) / 100;
                backendDeliveryPriceFils = Math.max(0, backendDeliveryPriceFils - discountVal);
            } else {
                backendDeliveryPriceFils = Math.max(0, backendDeliveryPriceFils - amt);
            }
        }

        // Preserve client's original delivery price if sent, else use calculated
        value.originalDeliveryPrice = value.originalDeliveryPrice ?? originalFils;
    } catch (pricingErr) {
        logger.error(`[OrderController] Pricing calculation failed: ${pricingErr.message}`);
        backendDeliveryPriceFils = value.totalDeliveryPrice;
    }

    const clientDeliveryPriceFils = (value.totalDeliveryPrice || 0) < 100
        ? Math.round((value.totalDeliveryPrice || 0) * 1000)
        : (value.totalDeliveryPrice || 0);
    const deliveryDiffFils = backendDeliveryPriceFils - clientDeliveryPriceFils;
    const clientTotalPriceKd = (value.totalPrice || 0) > 100
        ? (value.totalPrice || 0) / 1000
        : (value.totalPrice || 0);
    const adjustedTotalPriceKd = Math.max(0, clientTotalPriceKd + (deliveryDiffFils / 1000));
    const finalTotalPriceKd = Number(adjustedTotalPriceKd.toFixed(3));

    let resolvedVehicleName = value.vehicleName || value.vehicleTypeName || null;
    if (!resolvedVehicleName && pricing && pricing.name_ar) {
        resolvedVehicleName = pricing.name_ar || pricing.name_en || null;
    }

    const order = new Order({
        clientId: value.clientId,
        originalDeliveryPrice: value.originalDeliveryPrice,
        totalDeliveryPrice: backendDeliveryPriceFils,
        discountAmount: value.discountAmount || 0,
        discountPercentage: value.discountPercentage ?? null,
        discountCode: value.discountCode || null,
        discountType: value.discountType || null,
        totalPrice: finalTotalPriceKd,
        totalDistanceKm: distanceMeters / 1000,
        vehicleTypeId: value.vehicleTypeId,
        vehicleName: resolvedVehicleName,
        vehicleTypeName: resolvedVehicleName,
        orderType: value.orderType || value.orderCategory || null,
        orderCategory: value.orderCategory || (value.orderType === 'passenger' ? 'passenger' : (value.orderType === 'purchase' ? 'purchase' : 'delivery')),
        paymentMethod: value.paymentMethod || 'cash',
        representativeWillPay: Boolean(value.representativeWillPay),
        representativePaymentAmount: Number(value.representativePaymentAmount) || 0,
        purchaseDetails: value.purchaseDetails || '',
        tasks,
        allLocationsInOrder: req.body.allLocationsInOrder || value.allLocationsInOrder || [],

        pricingVersion,
        routeStatus,
        routeSource: 'GOOGLE',
        routeSnapshot
    });

    if (routeStatus === 'READY' && !routeSnapshot.encodedPolyline) {
        order.routeStatus = 'FAILED';
    }

    await order.save();

    await consumeDiscountAfterSuccessfulOrder({
        clientId: value.clientId,
        discountCode: value.discountCode,
        discountType: value.discountType,
        discountAmount: value.discountAmount,
    });

    const commissionCfg = await getCachedRepCommission().catch(() => null);
    let [formatted] = await enrichOrdersWithVehicleData(req, [formatOrder(req, order, commissionCfg)]);

    if (idempotencyKey) {
        await redisSet(`idempotency:order:${idempotencyKey}`, formatted, 3600);
    }

    return res.status(201).json(formatted);
});

/**
 * @description Get order route geometry
 * @route GET /api/orders/:id/route
 * @access Private (Client, Representative, or Admin)
 */
const getOrderRoute = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
        return res.status(400).json({ message: 'orderId must be a positive integer' });
    }

    // 🚀 Check active live trip route from Redis or Mongo Trip first
    try {
        const activeRouteRaw = await redisGet(`active_route:${id}`);
        if (activeRouteRaw) {
            const active = typeof activeRouteRaw === 'string' ? JSON.parse(activeRouteRaw) : activeRouteRaw;
            if (active && active.encodedPolyline) {
                return res.status(200).json({
                    schemaVersion: 1,
                    encodedPolyline: active.encodedPolyline,
                    distanceMeters: active.distanceMeters || 0,
                    durationSeconds: active.durationSeconds || 0,
                    routeVersion: active.routeVersion || 1,
                    compression: 'none'
                });
            }
        }

        const { Trip } = require('../models/Trip');
        const activeTrip = await Trip.findById(String(id)).lean();
        if (activeTrip && activeTrip.encodedPolyline) {
            return res.status(200).json({
                schemaVersion: 1,
                encodedPolyline: activeTrip.encodedPolyline,
                distanceMeters: activeTrip.distanceMeters || 0,
                durationSeconds: activeTrip.durationSeconds || 0,
                routeVersion: activeTrip.routeVersion || 1,
                compression: 'none'
            });
        }
    } catch (activeErr) {
        logger.error(`[OrderController] Active route lookup error: ${activeErr.message}`);
    }

    // Check Redis Shared Cache first
    const cacheKey = `order_route:${id}`;
    let cachedRoute = null;
    try {
        cachedRoute = await redisGet(cacheKey);
    } catch (err) { }

    let routeSnapshot;

    if (cachedRoute) {
        // Assume security check is needed even if cached, so we must fetch order to verify owner.
        // Wait, if we fetch order for security, we hit Mongo anyway.
        // Actually, if we just store clientId and representativeId in the cache payload, we can verify it without Mongo!
    }

    // So let's fetch the order directly, it's fast enough. Or we can just include security info in cache.
    // Let's do a fast lean query for security:
    const numericId = Number(id);
    if (isNaN(numericId)) {
        return res.status(404).json({ message: 'Order not found' });
    }

    const order = await Order.findOne({ orderId: numericId }).select('clientId representativeId routeSnapshot routeStatus').lean();
    if (!order) {
        return res.status(404).json({ message: 'Order not found' });
    }

    // Security Check
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
    const isClient = order.clientId && order.clientId.toString() === userId;
    const isRep = order.representativeId && order.representativeId.toString() === userId;

    if (!isAdmin && !isClient && !isRep) {
        return res.status(403).json({ message: 'Forbidden: You do not have access to this route' });
    }

    if (!order.routeSnapshot || !order.routeSnapshot.encodedPolyline || order.routeStatus === 'FAILED') {
        return res.status(404).json({ message: 'No route available for this order' });
    }

    if (cachedRoute) {
        routeSnapshot = cachedRoute;
    } else {
        routeSnapshot = order.routeSnapshot;

        // Async Decompression (only read once from Mongo, decompress before sending/caching)
        if (routeSnapshot.compression === 'gzip' && routeSnapshot.encodedPolyline) {
            const buffer = Buffer.from(routeSnapshot.encodedPolyline, 'base64');
            const unzipped = await gunzipAsync(buffer);
            routeSnapshot.encodedPolyline = unzipped.toString('utf8');
            routeSnapshot.compression = 'none'; // reset to none for the client
        }

        // Cache in Redis for 5 minutes (300 seconds)
        await redisSet(cacheKey, routeSnapshot, 300);
    }

    // ETag Support
    if (routeSnapshot.schemaVersion && routeSnapshot.routeChecksum) {
        const eTag = `"${routeSnapshot.schemaVersion}-${routeSnapshot.routeChecksum}"`;
        res.setHeader('ETag', eTag);

        const ifNoneMatch = req.headers['if-none-match'];
        if (ifNoneMatch === eTag) {
            return res.status(304).end();
        }
    }

    return res.status(200).json(routeSnapshot);
});

/**
 * @description Get order by numeric orderId — includes representative profile data
 * @route GET /api/orders/:id
 * @access Public
 */
const getOrderById = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
        return res.status(400).json({ message: 'orderId must be a positive integer' });
    }

    let order = await Order.findOne({
        orderId: id,
        isBusinessOrder: { $ne: true },
        orderCategory: { $ne: 'business' },
    });
    const commissionCfg = await getCachedRepCommission().catch(() => null);
    if (!order) {
        return sanitizeErrorResponse(res, false, true);
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isClientOwner = order.clientId && order.clientId.toString() === req.user?.id?.toString();
    const isRepOwner = order.representativeId && order.representativeId.toString() === req.user?.id?.toString();
    const isWaiting = normalizeOrderStatus(order.status) === 'waiting';

    if (!isClientOwner && !isRepOwner && !isWaiting && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    let [enriched] = await enrichOrdersWithRepData(req, [formatOrder(req, order, commissionCfg)]);
    [enriched] = await enrichOrdersWithClientData(req, [enriched]);
    [enriched] = await enrichOrdersWithVehicleData(req, [enriched]);

    // 🚀 Attach active DeliverySession and active OTP code for customer & driver sync
    try {
        const { DeliverySession } = require('../models/DeliverySession');
        let session = await DeliverySession.findOne({ orderId: id }).sort({ createdAt: -1 }).lean();
        if (!session) {
            session = await DeliverySession.findOne({ orderId: String(id) }).sort({ createdAt: -1 }).lean();
        }
        if (session) {
            let otpCode = session.activeOtpCode;
            if (!otpCode && session.otpVersion > 0) {
                const { getPlainOTP } = require('../config/redis');
                otpCode = await getPlainOTP(session.sessionId, session.otpVersion);
            }
            enriched.deliverySession = session;
            enriched.otp = {
                code: otpCode,
                version: session.otpVersion,
                isAvailable: !!otpCode,
            };
            enriched.otpCode = otpCode;
        }
    } catch (sessionErr) {
        logger.error(`[OrderController] Error attaching delivery session: ${sessionErr.message}`);
    }

    try {
        const { DeliveryOrderTracker } = require('../services/DeliveryOrderTracker');
        const trackData = await DeliveryOrderTracker.getOrderTrack(order.orderId);
        if (trackData) {
            enriched.track = trackData;
            enriched.currentStopIndex = trackData.currentStopIndex;
            enriched.currentStop = trackData.currentStop;
            enriched.stops = trackData.stops;
            enriched.phase = trackData.phase;
            enriched.allPickupsDone = trackData.allPickupsDone;
            enriched.isAllCompleted = trackData.isAllCompleted;
        }
    } catch (_) { }

    return res.status(200).json(enriched);
});


/**
 * @description Update order status (string)
 * @route PATCH /api/orders/:id/status
 * @access Public
 */
const updateOrderStatus = asyncHandler(async (req, res) => {
    const rawId = req.params.id;
    let order = null;
    if (mongoose.Types.ObjectId.isValid(rawId)) {
        order = await Order.findById(rawId);
    }
    if (!order && !isNaN(Number(rawId))) {
        order = await Order.findOne({ orderId: Number(rawId) });
    }
    if (!order) {
        return sanitizeErrorResponse(res, false, true);
    }

    const { error, value } = joi
        .object({
            status: joi
                .string()
                .valid(...ORDER_STATUSES)
                .required()
                .messages({
                    'any.required': 'status is required',
                    'any.only': `status must be one of: ${ORDER_STATUSES.join(', ')}`,
                }),
        })
        .validate(req.body);

    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (!isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const id = order.orderId || (isNaN(Number(rawId)) ? rawId : Number(rawId));
    const previousStatus = normalizeOrderStatus(order.status);
    order.status = value.status;
    await order.save();

    const st = normalizeOrderStatus(order.status);

    // ─── Fire-and-forget: check target reward & send email when order completes ────────────
    if ((st === 'completed' || st === 'delivered') && order.representativeId) {
        checkAndRewardTarget(order.representativeId).catch(() => { });

        const { sendDeliveryOrderCompletionEmail, dispatchBackgroundEmail } = require('../services/emailService');
        dispatchBackgroundEmail(async () => {
            await sendDeliveryOrderCompletionEmail(order);
        });

        // HR tracking update for delivered orders
        (async () => {
            try {
                const { clearRepCurrentOrder } = require('../redis/hrRedis');
                const AttendanceRecord = require('../models/AttendanceRecord');
                const RepActivityLog = require('../models/RepActivityLog');
                const { detectCurrentShift } = require('../utils/shiftDetector');

                const repId = order.representativeId;
                const { meta, shift } = await detectCurrentShift(repId);

                await clearRepCurrentOrder(repId);
                await AttendanceRecord.updateOne(
                    { representativeId: repId, dateStr: meta.dateStr },
                    { $inc: { ordersDelivered: 1 } }
                );
                await RepActivityLog.create({
                    representativeId: repId,
                    shiftId: shift ? shift._id : null,
                    dateStr: meta.dateStr,
                    week: meta.week,
                    month: meta.month,
                    year: meta.year,
                    eventType: 'order_delivered',
                    orderId: order.orderId,
                    orderStatus: st,
                    timestamp: new Date(),
                });
            } catch (hrErr) {
                console.error('[updateOrderStatus] HR tracking error:', hrErr.message);
            }
        })();
    }

    // ─── Emit real-time status change via Socket.IO ───────────────────────────
    try {
        const io = req.app.get('io');
        if (io) {
            const room = `order:${id}`;
            const payload = {
                orderId: id,
                status: st,
                previousStatus,
                message: `Order status changed to ${st}`,
            };
            io.to(room).emit('order:status_changed', payload);
            if (order.clientId) {
                io.to(`user:${order.clientId}`).emit('order:status_changed', payload);
            }
            console.log(`[Socket.IO] Emitted order:status_changed (${st}) to room ${room} and user:${order.clientId}`);
        }
    } catch (socketErr) {
        console.error('[Socket.IO] Failed to emit order:status_changed:', socketErr.message);
    }

    return res.status(200).json({
        orderId: order.orderId,
        status: st,
        statusLabel: st,
        orderType: order.orderType || null,
        updatedAt: order.updatedAt,
    });
});

/**
 * @description Get current status of an order
 * @route GET /api/orders/:id/status
 * @access Public
 */
const getOrderStatus = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
        return res.status(400).json({ message: 'orderId must be a positive integer' });
    }

    const order = await Order.findOne({ orderId: id }).select('orderId clientId representativeId status updatedAt cancellationReason reviewReason orderType');
    if (!order) {
        return sanitizeErrorResponse(res, false, true);
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isClientOwner = order.clientId && order.clientId.toString() === req.user?.id?.toString();
    const isRepOwner = order.representativeId && order.representativeId.toString() === req.user?.id?.toString();

    if (!isClientOwner && !isRepOwner && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const st = normalizeOrderStatus(order.status);
    let trackData = null;
    try {
        const { DeliveryOrderTracker } = require('../services/DeliveryOrderTracker');
        trackData = await DeliveryOrderTracker.getOrderTrack(id);
    } catch (_) { }

    return res.status(200).json({
        orderId: order.orderId,
        status: st,
        statusLabel: st,
        orderType: order.orderType || null,
        cancellationReason: order.cancellationReason || null,
        reviewReason: order.reviewReason || null,
        updatedAt: order.updatedAt,
        track: trackData,
        currentStopIndex: trackData?.currentStopIndex ?? null,
        stops: trackData?.stops ?? [],
        phase: trackData?.phase ?? null,
        isAllCompleted: trackData?.isAllCompleted ?? (st === 'completed' || st === 'delivered'),
    });
});

/**
 * @description Cancel order (status → cancelled) with reason
 * @route POST /api/orders/:id/cancel
 * @access Public
 */
const cancelOrder = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
        return res.status(400).json({ message: 'orderId must be a positive integer' });
    }

    const { error, value } = validateCancelOrder(req.body);
    if (error) {
        return res.status(400).json({
            message: error.details.map((d) => d.message).join('; '),
        });
    }

    const order = await Order.findOne({ orderId: id });
    if (!order) {
        return sanitizeErrorResponse(res, false, true);
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isClientOwner = order.clientId && order.clientId.toString() === req.user?.id?.toString();
    const isRepOwner = order.representativeId && order.representativeId.toString() === req.user?.id?.toString();

    if (!isClientOwner && !isRepOwner && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const st = normalizeOrderStatus(order.status);
    if (st === 'cancelled' || st === 'deleted') {
        return res.status(400).json({ message: 'Order is already cancelled or deleted' });
    }

    // ─── خصم رسوم الإلغاء إذا مضى وقت أكثر من التايمر على قبول المندوب ───
    let cancellationFeeApplied = false;
    if (
        ['accepted', 'delivering', 'confirmed', 'processing'].includes(st) &&
        order.acceptedAt &&
        order.representativeId
    ) {
        try {
            const pricing = await getOrCreatePricing();
            const cancelMinutes = pricing.clientCancellationTimerMinutes ?? pricing.arrivalTimerMinutes ?? 10;
            const timerMs = cancelMinutes * 60 * 1000;
            const elapsedMs = Date.now() - new Date(order.acceptedAt).getTime();

            if (elapsedMs >= timerMs && pricing.cancellationFeeForClient > 0) {
                const { debitWalletAllowNegative, creditWallet } = require('../middlewares/Wallet');
                const refId = String(order.orderId);

                // خصم من محفظة العميل
                try {
                    await debitWalletAllowNegative({
                        userId: order.clientId,
                        amountFils: pricing.cancellationFeeForClient,
                        type: 'cancellation_fee',
                        description: `رسوم إلغاء الأوردر #${order.orderId}`,
                        refId,
                        performedBy: 'system',
                    });
                    cancellationFeeApplied = true;
                } catch (walletErr) {
                    logger.error(`[cancelOrder] فشل خصم رسوم الإلغاء من العميل: ${walletErr.message}`);
                }

                // إضافة مكافأة للمندوب
                if (pricing.cancellationRewardForDriver > 0) {
                    try {
                        await creditWallet({
                            userId: order.representativeId,
                            amountFils: pricing.cancellationRewardForDriver,
                            type: 'cancellation_reward',
                            description: `مكافأة إلغاء العميل — أوردر #${order.orderId}`,
                            refId,
                            performedBy: 'system',
                        });
                    } catch (driverWalletErr) {
                        logger.error(`[cancelOrder] فشل إضافة مكافأة المندوب: ${driverWalletErr.message}`);
                    }
                }
            }
        } catch (pricingErr) {
            logger.error(`[cancelOrder] خطأ في جلب إعدادات التسعير: ${pricingErr.message}`);
        }
    }

    const oldRepId = order.representativeId;
    order.status = 'cancelled';
    order.cancellationReason = value.reason;
    await order.save();

    if (oldRepId) {
        try {
            const { clearRepCurrentOrder, invalidateLiveDashboard } = require('../redis/hrRedis');
            await clearRepCurrentOrder(oldRepId);
            await invalidateLiveDashboard();
        } catch (_) { }
    }

    // ─── إشعار العميل بالإلغاء ──────────────────────────────────────────────
    notifyClient(
        order.clientId,
        '❌ تم إلغاء الطلب',
        `طلبك تم إلغاؤه. السبب: ${value.reason || 'غير محدد'}`,

        { type: 'order_cancelled', orderId: String(order.orderId) },
    ).catch(() => { });

    return res.status(200).json({
        message: 'Order cancelled successfully',
        cancellationFeeApplied,
        ...formatOrder(req, order),
    });
});

// --- Haversine Formula for distance calculation (with 1.30x urban road factor & swap protection) ---
function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
    let p1Lat = parseFloat(lat1);
    let p1Lng = parseFloat(lon1);
    let p2Lat = parseFloat(lat2);
    let p2Lng = parseFloat(lon2);
    if (isNaN(p1Lat) || isNaN(p1Lng) || isNaN(p2Lat) || isNaN(p2Lng)) return null;

    // Swap protection for Middle East / Kuwait (Lat ~20-35, Lng ~40-55)
    if (p1Lat > 40 && p1Lng < 35) { const t = p1Lat; p1Lat = p1Lng; p1Lng = t; }
    if (p2Lat > 40 && p2Lng < 35) { const t = p2Lat; p2Lat = p2Lng; p2Lng = t; }

    const R = 6371; // Radius of the earth in km
    const dLat = deg2rad(p2Lat - p1Lat);
    const dLon = deg2rad(p2Lng - p1Lng);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(p1Lat)) * Math.cos(deg2rad(p2Lat)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const straightKm = R * c; // Distance in km
    // Multiply by 1.30 urban road routing factor to accurately estimate actual driving road distance
    return Number((straightKm * 1.30).toFixed(2));
}

function extractTaskPickupCoords(task) {
    if (!task) return null;
    let lat = task.fromLatitude ?? task.pickupLocation?.lat ?? task.pickupLocation?.latitude;
    let lng = task.fromLongitude ?? task.pickupLocation?.lng ?? task.pickupLocation?.longitude;
    if (lat != null && lng != null) {
        let pLat = parseFloat(lat);
        let pLng = parseFloat(lng);
        if (!isNaN(pLat) && !isNaN(pLng)) {
            if (pLat > 40 && pLng < 35) { const t = pLat; pLat = pLng; pLng = t; }
            if (Math.abs(pLat) > 1.0 && Math.abs(pLng) > 1.0) {
                return { lat: pLat, lng: pLng };
            }
        }
    }
    return null;
}

function extractTaskDeliveryCoords(task) {
    if (!task) return null;
    let lat = task.toLatitude ?? task.deliveryLocation?.lat ?? task.deliveryLocation?.latitude;
    let lng = task.toLongitude ?? task.deliveryLocation?.lng ?? task.deliveryLocation?.longitude;
    if (lat != null && lng != null) {
        let pLat = parseFloat(lat);
        let pLng = parseFloat(lng);
        if (!isNaN(pLat) && !isNaN(pLng)) {
            if (pLat > 40 && pLng < 35) { const t = pLat; pLat = pLng; pLng = t; }
            if (Math.abs(pLat) > 1.0 && Math.abs(pLng) > 1.0) {
                return { lat: pLat, lng: pLng };
            }
        }
    }
    return null;
}

function calculateOrderTripDistance(order) {
    if (!order) return 0;
    if (order.routeSnapshot && order.routeSnapshot.distanceMeters > 0) {
        return Number((order.routeSnapshot.distanceMeters / 1000).toFixed(2));
    }
    if (order.totalDistanceKm && order.totalDistanceKm > 0) {
        return Number(order.totalDistanceKm.toFixed(2));
    }
    const tasks = order.tasks || [];
    let sumKm = 0;
    for (const t of tasks) {
        if (t.distanceKm && parseFloat(t.distanceKm) > 0) {
            sumKm += parseFloat(t.distanceKm);
        } else {
            const pickup = extractTaskPickupCoords(t);
            const delivery = extractTaskDeliveryCoords(t);
            if (pickup && delivery) {
                const dist = getDistanceFromLatLonInKm(pickup.lat, pickup.lng, delivery.lat, delivery.lng);
                if (dist != null) sumKm += dist;
            }
        }
    }
    return Number(sumKm.toFixed(2));
}

const jwt = require('jsonwebtoken');

/**
 * @description List all waiting orders (for representative dashboard)
 * @route GET /api/orders/waiting
 * @access Public (representative)
 */
const listWaitingOrders = asyncHandler(async (req, res) => {
    const { lat, lng } = req.query;

    // Check representative preferences if user token is provided
    let repUser = null;
    try {
        const token = req.user?.id ? null : (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.substring(7) : req.headers.token);
        const userId = req.user?.id || (token ? jwt.verify(token, process.env.JWT_SECRET)?.id : null);
        if (userId) {
            repUser = await User.findById(userId).select('vehicleTypeId vehicleTypeName preferredOrderTypes').lean();
        }
    } catch (_) { }

    // 1. Filter orders strictly based on representative role/specialization:
    // - Passenger delegate (مندوب توصيل أفراد): sees ONLY passenger orders
    // - Delivery delegate (مندوب توصيل وشراء طلبات): sees ONLY delivery & purchase orders
    let orderCategoryFilter = { $in: ['delivery', 'purchase', null] };
    if (repUser && Array.isArray(repUser.preferredOrderTypes) && repUser.preferredOrderTypes.length > 0) {
        const isPassenger = repUser.preferredOrderTypes.some(t => t && t.toString().toLowerCase().trim() === 'passenger');
        if (isPassenger) {
            orderCategoryFilter = 'passenger';
        } else {
            orderCategoryFilter = { $in: ['delivery', 'purchase', null] };
        }
    }

    let orders = await Order.find({
        status: 'waiting',
        orderCategory: orderCategoryFilter
    }).sort({ orderId: -1 }).lean();

    // 2. Filter orders by representative vehicle type if set
    if (repUser && (repUser.vehicleTypeId || repUser.vehicleTypeName)) {
        const driverVtIdStr = repUser.vehicleTypeId ? repUser.vehicleTypeId.toString() : null;
        const driverVtName = (repUser.vehicleTypeName || '').toLowerCase().trim();

        orders = orders.filter(o => {
            const orderVtIdStr = o.vehicleTypeId ? o.vehicleTypeId.toString() : null;
            const orderVtName = (o.vehicleTypeName || o.vehicleName || '').toLowerCase().trim();

            // If order has no vehicle type requirements, allow it for all
            if (!orderVtIdStr && !orderVtName) return true;

            // Match by ObjectId
            if (driverVtIdStr && orderVtIdStr && driverVtIdStr === orderVtIdStr) return true;

            // Match by Name
            if (driverVtName && orderVtName && (orderVtName.includes(driverVtName) || driverVtName.includes(orderVtName))) return true;

            return false;
        });
    }

    // Apply progressive filtering and distanceToPickup calculation if lat and lng are provided
    if (lat && lng) {
        const userLat = parseFloat(lat);
        const userLng = parseFloat(lng);

        // Calculate distance for each order based on the first task's pickup location using Haversine
        const ordersWithDistance = orders.map(order => {
            const firstTask = order.tasks && order.tasks[0];
            const pickup = extractTaskPickupCoords(firstTask);
            let distanceToPickup = null;
            if (pickup && !isNaN(userLat) && !isNaN(userLng)) {
                distanceToPickup = getDistanceFromLatLonInKm(userLat, userLng, pickup.lat, pickup.lng);
            }
            return { ...order, distanceToPickup };
        });

        // Try progressive radius: 5km, 7km, 10km, 15km
        const radii = [5, 7, 10, 15];
        let filteredOrders = [];

        for (const radius of radii) {
            filteredOrders = ordersWithDistance.filter(o => o.distanceToPickup !== null && o.distanceToPickup <= radius);
            if (filteredOrders.length > 0) {
                break; // Found orders within this radius, stop expanding
            }
        }

        if (filteredOrders.length > 0) {
            filteredOrders.sort((a, b) => (a.distanceToPickup || 9999) - (b.distanceToPickup || 9999));
            orders = filteredOrders;
        } else {
            orders = ordersWithDistance;
        }
    }

    const commissionCfg = await getCachedRepCommission().catch(() => null);
    const formatted = orders.map((o) => {
        const item = formatOrder(req, o, commissionCfg);
        if (o.distanceToPickup != null) {
            item.distanceToPickup = Number(o.distanceToPickup.toFixed(2));
            item.distanceFromRepKm = Number(o.distanceToPickup.toFixed(2));
        }
        return item;
    });
    const finalFormatted = await enrichOrdersWithClientData(req, formatted);
    return res.status(200).json({
        succeeded: true,
        data: finalFormatted,
        count: finalFormatted.length,
    });
});

/**
 * @description Accept a waiting order — sets status to 'accepted' and records the representativeId
 * @route PATCH /api/orders/:id/accept
 * @access Public (representative)
 */
const acceptOrder = asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
        return res.status(400).json({ message: 'orderId must be a positive integer' });
    }

    const { error, value } = joi
        .object({
            representativeId: joi.string().trim().allow('').optional().default(''),
        })
        .validate(req.body, { allowUnknown: false });

    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const order = await Order.findOne({ orderId: id });
    if (!order) {
        return res.status(404).json({ message: 'Order not found' });
    }

    const currentStatus = normalizeOrderStatus(order.status);
    if (currentStatus !== 'waiting') {
        return res.status(409).json({
            message: 'Order is already accepted or no longer available',
            status: currentStatus,
        });
    }

    // ─── التحقق الشامل من الأهلية والشيفت والحضور والانصراف قبل قبول الطلب ─────
    const repId = value.representativeId || req.user?.id;
    if (repId) {
        const { checkRepCanAcceptOrder } = require('../utils/orderAcceptanceGuard');
        const guardResult = await checkRepCanAcceptOrder(repId, order);
        if (!guardResult.canAccept) {
            return res.status(guardResult.statusCode || 403).json({
                message: guardResult.message,
                code: guardResult.code,
            });
        }
    }

    order.status = 'accepted';
    if (value.representativeId) {
        order.representativeId = value.representativeId;
    } else if (req.user && req.user.id) {
        order.representativeId = req.user.id;
    }
    order.acceptedAt = new Date(); // تسجيل وقت القبول — يُستخدم لحساب رسوم الإلغاء
    await order.save();

    // HR tracking for accepted order
    (async () => {
        try {
            const acceptedRepId = order.representativeId;
            if (acceptedRepId) {
                const { setRepCurrentOrder } = require('../redis/hrRedis');
                const RepActivityLog = require('../models/RepActivityLog');
                const { detectCurrentShift } = require('../utils/shiftDetector');
                const { meta, shift } = await detectCurrentShift(acceptedRepId);

                await setRepCurrentOrder(acceptedRepId, {
                    orderId: String(order.orderId || order._id),
                    status: 'accepted',
                    orderStatus: 'accepted',
                    acceptedAt: new Date().toISOString(),
                });

                await RepActivityLog.create({
                    representativeId: acceptedRepId,
                    shiftId: shift ? shift._id : null,
                    dateStr: meta.dateStr,
                    week: meta.week,
                    month: meta.month,
                    year: meta.year,
                    eventType: 'order_accepted',
                    orderId: order.orderId,
                    orderStatus: 'accepted',
                    timestamp: new Date(),
                });
            }
        } catch (hrErr) {
            console.error('[acceptOrder] HR tracking error:', hrErr.message);
        }
    })();

    const commissionCfg = await getCachedRepCommission().catch(() => null);
    let [formatted] = await enrichOrdersWithRepData(req, [formatOrder(req, order, commissionCfg)]);
    [formatted] = await enrichOrdersWithClientData(req, [formatted]);

    // ─── Publish to Redis → tracking-service ─────────────────────────────────
    try {
        const { getRedisClient } = require('../config/redis');
        const redisPub = getRedisClient();
        if (redisPub) {
            const tasks = order.tasks || [];
            const firstTask = tasks[0] || {};
            const lastTask = tasks[tasks.length - 1] || {};

            let driverLat = undefined;
            let driverLng = undefined;
            const repId = order.representativeId || req.user?.id || '';
            if (repId) {
                const driver = await User.findById(repId).select('lastLocation').lean();
                if (driver && driver.lastLocation && driver.lastLocation.lat && driver.lastLocation.lng) {
                    driverLat = driver.lastLocation.lat;
                    driverLng = driver.lastLocation.lng;
                }
            }

            await redisPub.publish('trip:events', JSON.stringify({
                event: 'order_accepted',
                orderId: id,
                representativeId: repId,
                driverLat,
                driverLng,
                originLat: firstTask.fromLatitude || 0,
                originLng: firstTask.fromLongitude || 0,
                destinationLat: lastTask.toLatitude || 0,
                destinationLng: lastTask.toLongitude || 0,
                destinationId: 'order_' + id,
                destinationType: 'delivery',
            }));
        }
    } catch (redisErr) {
        console.error('[acceptOrder] Redis publish error:', redisErr.message);
    }

    // ─── ⚡ Emit order:accepted via Socket.IO → order room ──────────────────
    try {
        const io = req.app.get('io');
        if (io) {
            const room = `order:${id}`;
            const payload = {
                orderId: id,
                status: 'accepted',
                order: formatted,
                message: 'تم قبول طلبك من قِبَل المندوب',
            };
            io.to(room).emit('order:accepted', payload);
            io.to(room).emit('order:status_changed', payload);
            if (order.clientId) {
                io.to(`user:${order.clientId}`).emit('order:accepted', payload);
                io.to(`user:${order.clientId}`).emit('order:status_changed', payload);
            }
            console.log(`[Socket.IO] ✅ Emitted order:accepted to room ${room} and user:${order.clientId}`);
        } else {
            console.warn('[acceptOrder] ⚠️ Socket.IO instance not found on app');
        }
    } catch (socketErr) {
        console.error('[acceptOrder] ❌ Failed to emit order:accepted:', socketErr.message);
    }

    // ─── إشعار FCM للعميل ────────────────────────────────────────────────
    const repName = formatted.representativeName || 'المندوب';
    notifyClient(
        order.clientId,
        '✅ تم قبول طلبك',
        `${repName} في الطريق إليك`,
        { type: 'order_accepted', orderId: String(order.orderId) },
    ).catch(() => { });

    return res.status(200).json({
        succeeded: true,
        message: 'Order accepted successfully',

        ...formatted,
    });
});

/**
 * Helper to find a delivery Order document by numeric ID or MongoDB ObjectId.
 * Store/business orders are intentionally excluded.
 */
async function findOrderFlexible(rawId) {
    if (!rawId) return { order: null, storeOrders: [] };
    const mongoose = require('mongoose');

    const strId = String(rawId).trim();
    const numId = !isNaN(Number(strId)) ? Number(strId) : -1;
    const isValidObjId = mongoose.isValidObjectId(strId);

    const deliveryFilter = {
        isBusinessOrder: { $ne: true },
        orderCategory: { $ne: 'business' },
    };

    // 1. Numeric ID
    if (numId > 0) {
        const o = await Order.findOne({ orderId: numId, ...deliveryFilter });
        if (o) return { order: o, storeOrders: [] };
    }

    // 2. ObjectId
    if (isValidObjId) {
        const o = await Order.findOne({ _id: strId, ...deliveryFilter });
        if (o) return { order: o, storeOrders: [] };
    }

    // 3. Fallback
    const fallback = await Order.findOne({
        $and: [
            deliveryFilter,
            { $or: [...(numId > 0 ? [{ orderId: numId }] : []), ...(isValidObjId ? [{ _id: strId }] : [])] }
        ]
    });
    if (fallback) return { order: fallback, storeOrders: [] };

    return { order: null, storeOrders: [] };
}

/**
 * @description تأكيد وصول المندوب لنقطة الاستلام — يبدأ التايمر (يدعم جميع أنواع الأوردرات)
 * @route PATCH /api/orders/:id/confirm-arrival
 * @access Private (Representative)
 */
const confirmArrival = asyncHandler(async (req, res) => {
    const { order, storeOrders } = await findOrderFlexible(req.params.id);
    if (!order) return sanitizeErrorResponse(res, false, true);

    const repId = req.user?.id?.toString();
    const isRep = (order.representativeId && order.representativeId.toString() === repId);
    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (!isRep && !isAdmin) return sanitizeErrorResponse(res, true, true);

    const allowedStatuses = ['accepted', 'delivering', 'confirmed', 'processing', 'pending', 'waiting', 'inprogress', 'shipped', 'ready', 'return_accepted', 'return_delivering'];
    const st = normalizeOrderStatus(order.status);
    if (!allowedStatuses.includes(st)) {
        return res.status(400).json({ message: `لا يمكن تأكيد الوصول لأوردر بحالة ${st}` });
    }

    const pricing = await getOrCreatePricing();
    const timerMinutes = pricing.arrivalTimerMinutes || 10;
    const now = new Date();
    const expiredAt = new Date(now.getTime() + timerMinutes * 60 * 1000);

    order.arrivalConfirmedAt = now;
    order.arrivalTimerExpiredAt = expiredAt;
    if (!order.clientId && (order.userId || order._doc?.userId)) {
        order.clientId = String(order.userId || order._doc?.userId);
    }
    await order.save();

    const isReturn = order.isReturnOrder || (typeof order.status === 'string' && order.status.startsWith('return_'));
    const clientId = order.clientId || order.userId;
    if (clientId) {
        notifyClient(
            clientId,
            isReturn ? '🚶 مندوب الاسترجاع وصل!' : '🚶 المندوب وصل!',
            isReturn ? `المندوب في نقطة الاستلام لاستلام المنتجات المرتجعة. لديك ${timerMinutes} دقيقة للنزول.` : `المندوب في نقطة الاستلام. لديك ${timerMinutes} دقيقة للنزول.`,
            { type: 'driver_arrived', orderId: String(order.orderId || req.params.id) },
        ).catch(() => { });
    }

    try {
        const io = req.app.get('io');
        if (io) {
            const refId = String(order.orderId || req.params.id);
            const payload = {
                orderId: refId,
                arrivalConfirmedAt: now,
                arrivalTimerExpiredAt: expiredAt,
                timerMinutes,
                isReturn,
            };
            io.to(`order:${refId}`).emit('driver:arrived', payload);
            if (clientId) {
                io.to(`user:${clientId}`).emit('driver:arrived', payload);
            }
        }
    } catch (_) { }

    return res.status(200).json({
        succeeded: true,
        message: 'تم تأكيد الوصول — التايمر بدأ',
        orderId: order.orderId || order.storeOrderId || req.params.id,
        arrivalConfirmedAt: now,
        arrivalTimerExpiredAt: expiredAt,
        timerMinutes,
    });
});

/**
 * @description المندوب يختار أن العميل تأخر — تغيير الحالة + خصم العميل + مكافأة المندوب
 * @route PATCH /api/orders/:id/mark-delayed
 * @access Private (Representative)
 */
const markClientDelayed = asyncHandler(async (req, res) => {
    const { order, storeOrders } = await findOrderFlexible(req.params.id);
    if (!order) return sanitizeErrorResponse(res, false, true);

    const repId = req.user?.id?.toString();
    const isRep = (order.representativeId && order.representativeId.toString() === repId);
    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (!isRep && !isAdmin) return sanitizeErrorResponse(res, true, true);

    if (order.isClientDelayed) {
        return res.status(400).json({ message: 'تم تسجيل تأخير العميل مسبقاً لهذا الأوردر' });
    }

    if (!order.arrivalTimerExpiredAt) {
        return res.status(400).json({ message: 'لم يتم تأكيد الوصول بعد — اضغط على تأكيد الوصول أولاً' });
    }

    const now = new Date();
    if (now < new Date(order.arrivalTimerExpiredAt)) {
        const remainingMs = new Date(order.arrivalTimerExpiredAt).getTime() - now.getTime();
        const remainingSec = Math.ceil(remainingMs / 1000);
        return res.status(400).json({
            message: `التايمر لم ينتهِ بعد. تبقى ${remainingSec} ثانية`,
            remainingSeconds: remainingSec,
            arrivalTimerExpiredAt: order.arrivalTimerExpiredAt,
        });
    }

    const pricing = await getOrCreatePricing();
    const { debitWalletAllowNegative, creditWallet } = require('../middlewares/Wallet');
    const refId = String(order.orderId || req.params.id);
    const clientId = order.clientId || order.userId;
    let clientFeeApplied = false;
    let driverRewardApplied = false;

    if (pricing.delayFeeForClient > 0 && clientId) {
        try {
            await debitWalletAllowNegative({
                userId: clientId,
                amountFils: pricing.delayFeeForClient,
                type: 'delay_fee',
                description: `رسوم تأخير الاستلام — أوردر #${refId}`,
                refId,
                performedBy: 'system',
            });
            clientFeeApplied = true;
        } catch (err) {
            logger.error(`[markClientDelayed] فشل خصم رسوم التأخير من العميل: ${err.message}`);
        }
    }

    const repUser = order.representativeId || req.user?.id;
    if (pricing.delayRewardForDriver > 0 && repUser) {
        try {
            await creditWallet({
                userId: repUser,
                amountFils: pricing.delayRewardForDriver,
                type: 'delay_reward',
                description: `مكافأة تأخر العميل — أوردر #${refId}`,
                refId,
                performedBy: 'system',
            });
            driverRewardApplied = true;
        } catch (err) {
            logger.error(`[markClientDelayed] فشل إضافة مكافأة المندوب: ${err.message}`);
        }
    }

    const oldRepId = order.representativeId;

    order.status = 'delayed';
    order.isClientDelayed = true;
    order.delayedAt = now;
    if (!order.clientId && (order.userId || order._doc?.userId)) {
        order.clientId = String(order.userId || order._doc?.userId);
    }
    if (!order.representativeId && oldRepId) order.representativeId = oldRepId;
    await order.save();

    if (oldRepId) {
        try {
            const { clearRepCurrentOrder, invalidateLiveDashboard } = require('../redis/hrRedis');
            await clearRepCurrentOrder(oldRepId);
            await invalidateLiveDashboard();
        } catch (_) { }
    }

    try {
        const io = req.app.get('io');
        if (io) {
            const room = `order:${refId}`;
            io.to(room).emit('order:delayed', {
                orderId: refId,
                status: 'delayed',
                message: 'تم تسجيل تأخير العميل وإغلاق الطلب',
            });
            if (oldRepId) {
                io.to(`driver:${oldRepId}`).emit('order:delayed', {
                    orderId: refId,
                    status: 'delayed',
                });
            }
        }
    } catch (socketErr) {
        console.error('[markClientDelayed] Failed to emit order:delayed:', socketErr.message);
    }

    if (clientId) {
        notifyClient(
            clientId,
            '⏰ انتهت مدة انتظار المندوب',
            'تم تسجيل تأخير على طلبك. قد تم خصم رسوم التأخير من محفظتك.',
            { type: 'order_delayed', orderId: refId },
        ).catch(() => { });
    }

    return res.status(200).json({
        succeeded: true,
        message: 'تم تسجيل التأخير بنجاح',
        orderId: order.orderId,
        status: 'delayed',
        delayedAt: now,
        clientFeeApplied,
        clientFeeAmountFils: clientFeeApplied ? pricing.delayFeeForClient : 0,
        driverRewardApplied,
        driverRewardAmountFils: driverRewardApplied ? pricing.delayRewardForDriver : 0,
    });
});

/**
 * @description Representative releases (un-accepts) an order → status back to 'waiting'
 * @route PATCH /api/orders/:id/release
 * @access Representative
 */
const releaseOrder = asyncHandler(async (req, res) => {
    const { order, storeOrders } = await findOrderFlexible(req.params.id);
    if (!order) {
        return res.status(404).json({ message: 'Order not found' });
    }

    const currentStatus = normalizeOrderStatus(order.status);
    const allowedReleaseStatuses = ['accepted', 'confirmed', 'processing', 'delivering', 'return_accepted', 'return_delivering'];
    if (!allowedReleaseStatuses.includes(currentStatus)) {
        return res.status(409).json({
            message: `Cannot release order with status '${currentStatus}'. Only accepted/active orders can be released.`,
            currentStatus,
        });
    }

    const repId = req.user?.id?.toString();
    const oldRepId = order.representativeId?.toString() || repId;
    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;

    if (!isAdmin && repId && oldRepId && repId !== oldRepId) {
        return res.status(403).json({ message: 'Access denied. You are not assigned to this order.' });
    }

    // ─── فحص مهلة الإلغاء وخصم الرسوم من محفظة المندوب إذا ألغى بعد انقضاء المهلة ───
    let cancellationFeeApplied = false;
    let cancellationFeeFils = 0;
    const acceptedAtTime = order.acceptedAt;

    if (acceptedAtTime && oldRepId) {
        try {
            const pricing = await getOrCreatePricing();
            const cancelMinutes = pricing.clientCancellationTimerMinutes ?? pricing.arrivalTimerMinutes ?? 10;
            const timerMs = cancelMinutes * 60 * 1000;
            const elapsedMs = Date.now() - new Date(acceptedAtTime).getTime();

            if (elapsedMs >= timerMs && pricing.cancellationFeeForClient > 0) {
                const { debitWalletAllowNegative } = require('../middlewares/Wallet');
                const refId = String(order.orderId || req.params.id);
                try {
                    await debitWalletAllowNegative({
                        userId: oldRepId,
                        amountFils: pricing.cancellationFeeForClient,
                        type: 'cancellation_fee',
                        description: `رسوم إلغاء قبول الأوردر #${refId} بعد تجاوز مهلة ${cancelMinutes} دقيقة`,
                        refId,
                        performedBy: 'system',
                    });
                    cancellationFeeApplied = true;
                    cancellationFeeFils = pricing.cancellationFeeForClient;
                    logger.info(`[releaseOrder] تم خصم رسوم إلغاء (${cancellationFeeFils} فلس) من المندوب ${oldRepId} لتجاوز المهلة للأوردر #${refId}`);
                } catch (walletErr) {
                    logger.error(`[releaseOrder] فشل خصم رسوم الإلغاء من محفظة المندوب: ${walletErr.message}`);
                }
            }
        } catch (pricingErr) {
            logger.error(`[releaseOrder] خطأ في جلب إعدادات التسعير: ${pricingErr.message}`);
        }
    }

    const cancelReason = req.body?.reason || 'المندوب اعتذر عن الطلب';

    const isReturn = order.isReturnOrder || (typeof order.status === 'string' && order.status.startsWith('return_'));
    order.status = isReturn ? 'return_pending' : 'waiting';
    order.representativeId = null;
    order.acceptedAt = null;
    order.cancellationReason = cancelReason;
    if (!order.clientId && (order.userId || order._doc?.userId)) {
        order.clientId = String(order.userId || order._doc?.userId);
    }
    await order.save();

    if (oldRepId) {
        try {
            const { clearRepCurrentOrder, invalidateLiveDashboard } = require('../redis/hrRedis');
            await clearRepCurrentOrder(oldRepId);
            await invalidateLiveDashboard();
        } catch (_) { }
    }

    const refId = String(order.orderId || req.params.id);

    // ─── Socket.IO Realtime update ──────────────────────────────────────────
    try {
        const io = req.app.get('io');
        if (io) {
            const isReturn = order.isReturnOrder || (typeof order.status === 'string' && order.status.startsWith('return_'));
            const resetStatus = isReturn ? 'return_pending' : 'waiting';
            const room = `order:${refId}`;
            const payload = {
                orderId: refId,
                status: resetStatus,
                previousStatus: currentStatus,
                message: 'عادت حالة الطلب للانتظار للبحث عن مندوب جديد',
            };
            io.to(room).emit('order:status_changed', payload);
            io.to(room).emit('order:released', {
                orderId: refId,
                status: resetStatus,
                cancellationFeeApplied,
                cancellationFeeFils,
            });
            if (order.clientId) {
                io.to(`user:${order.clientId}`).emit('order:status_changed', payload);
            }
        }
    } catch (socketErr) {
        logger.error(`[releaseOrder] Socket error: ${socketErr.message}`);
    }

    const clientId = order.clientId || order.userId;
    if (clientId) {
        notifyClient(
            clientId,
            '⏳ طلبك يبحث عن مندوب جديد',
            'المندوب اعتذر عن الطلب — جاري البحث عن مندوب آخر لك فوراً',
            { type: 'order_released', orderId: refId },
        ).catch(() => { });
    }

    if (cancellationFeeApplied && oldRepId) {
        const feeKd = (cancellationFeeFils / 1000).toFixed(2);
        notifyClient(
            oldRepId,
            '⚠️ خصم رسوم إلغاء الطلب',
            `تم خصم ${feeKd} ج.م من محفظتك كرسوم لإلغاء الطلب بعد انقضاء مهلة الإلغاء المحددة.`,
            { type: 'wallet_debit', orderId: refId, feeFils: String(cancellationFeeFils) },
        ).catch(() => { });
    }

    const formatted = formatOrder(req, order);

    return res.status(200).json({
        succeeded: true,
        message: cancellationFeeApplied
            ? `تم إلغاء قبول الطلب وعاد للانتظار، وتم خصم ${(cancellationFeeFils / 1000).toFixed(2)} ج.م كرسوم إلغاء لتجاوز المهلة.`
            : 'Order released back to waiting successfully',
        cancellationFeeApplied,
        cancellationFeeFils,
        cancellationFeeKD: cancellationFeeFils / 1000,
        ...formatted,
    });
});

/**
 * @description Search order by number
 * @route GET /api/orders/search-by-number
 * @access Private (Admin)
 */
const searchOrderByNumber = asyncHandler(async (req, res) => {
    const { orderId } = req.query;
    if (!orderId) {
        return res.status(400).json({ message: 'رقم الأوردر مطلوب للبحث' });
    }

    const numericId = parseInt(orderId.toString().trim());
    if (isNaN(numericId)) {
        return res.status(400).json({ message: 'رقم الأوردر يجب أن يكون رقماً صحيحاً' });
    }

    const mongoose = require('mongoose');

    // Helper: Safely fetch client by ID or Phone
    async function getClientObject(clientId, userInfoFallback) {
        let userDoc = null;
        if (clientId) {
            if (mongoose.Types.ObjectId.isValid(clientId)) {
                userDoc = await User.findById(clientId).lean();
            }
            if (!userDoc) {
                userDoc = await User.findOne({ phone: clientId }).lean();
            }
        }
        if (userDoc) {
            const name = `${userDoc.firstName || ''} ${userDoc.lastName || ''}`.trim() || userDoc.fullName || 'عميل';
            return {
                id: String(userDoc._id),
                fullName: name,
                phoneNumber: userDoc.phone || userDoc.phoneNumber || userInfoFallback?.phone || '',
                email: userDoc.email || '',
                governorate: userDoc.governorate || userInfoFallback?.governorate || '',
                avatar: sanitizeImageUrl(buildUrl(req, userDoc.profileImage || userDoc.avatar)),
            };
        }
        if (userInfoFallback) {
            const fallbackName = `${userInfoFallback.firstName || ''} ${userInfoFallback.lastName || ''}`.trim() || 'عميل المتجر';
            return {
                fullName: fallbackName,
                phoneNumber: userInfoFallback.phone || userInfoFallback.phoneNumber || '',
                governorate: userInfoFallback.governorate || '',
            };
        }
        return null;
    }

    // Helper: Safely fetch representative by ID
    async function getRepObject(repId) {
        if (!repId) return null;
        let repDoc = null;
        if (mongoose.Types.ObjectId.isValid(repId)) {
            repDoc = await User.findById(repId).lean();
        }
        if (!repDoc) {
            repDoc = await User.findOne({ phone: repId }).lean();
        }
        if (repDoc) {
            const name = `${repDoc.firstName || ''} ${repDoc.lastName || ''}`.trim() || repDoc.fullName || 'مندوب';
            return {
                id: String(repDoc._id),
                fullName: name,
                phoneNumber: repDoc.phone || repDoc.phoneNumber || '',
                vehicleNumber: repDoc.vehicleNumber || '',
                vehicleModel: repDoc.vehicleModel || '',
                vehicleColor: repDoc.vehicleColor || '',
                vehicleTypeName: repDoc.vehicleTypeName || repDoc.vehicleType || '',
                vehicleImage: sanitizeImageUrl(buildUrl(req, repDoc.vehicleImage)),
                avatar: sanitizeImageUrl(buildUrl(req, repDoc.profileImage || repDoc.avatar)),
            };
        }
        return null;
    }

    // 1. Try finding in Order (Delivery)
    let deliveryOrder = await Order.findOne({
        orderId: numericId,
        isBusinessOrder: { $ne: true },
        orderCategory: { $ne: 'business' },
    }).lean();
    if (deliveryOrder) {
        const clientObj = await getClientObject(deliveryOrder.clientId, null);
        const repObj = await getRepObject(deliveryOrder.representativeId);
        const formatted = formatOrder(req, deliveryOrder);

        return res.json({
            succeeded: true,
            orderTypeCategory: 'delivery',
            categoryLabel: 'مشاوير وتوصيل',
            orderId: deliveryOrder.orderId,
            mongoId: String(deliveryOrder._id),
            status: deliveryOrder.status,
            createdAt: deliveryOrder.createdAt,
            updatedAt: deliveryOrder.updatedAt,
            client: clientObj,
            representative: repObj,
            agent: null,
            vehicleRequired: deliveryOrder.vehicleTypeName || deliveryOrder.vehicleName || 'عام',
            pricing: {
                totalDeliveryPrice: (deliveryOrder.totalDeliveryPrice || 0) / 1000.0,
                originalDeliveryPrice: deliveryOrder.originalDeliveryPrice ? deliveryOrder.originalDeliveryPrice / 1000.0 : null,
                discountAmount: (deliveryOrder.discountAmount || 0) / 1000.0,
                totalPrice: ((deliveryOrder.totalPrice || deliveryOrder.totalDeliveryPrice || 0)) / 1000.0,
            },
            tasks: formatted.tasks || [],
            details: formatted,
        });
    }

    return sanitizeErrorResponse(res, false, true);
});

/**
 * @desc   Get comprehensive financial analytics and stats for completed orders (Admin)
 *         Filters delivery orders vs business orders by date range.
 *         Calculates:
 *           - Total completed orders count
 *           - Total completed orders revenue / price (المبالغ الداخلة للشركة)
 *           - Total delivery fees (توتال أسعار التوصيل)
 *           - Drivers' / Representatives' share (إجمالي مستحقات المناديب)
 *           - Company net profit from delivery & overall (صافي ربح الشركة)
 * @route  GET /api/orders/admin/financial-stats
 * @route  GET /api/store/orders/admin/financial-stats
 * @query  startDate, endDate, date, month, year, orderCategory
 * @access Admin
 */
const getAdminOrderFinancialStats = asyncHandler(async (req, res) => {
    const { Tafgeet } = require('tafgeet-arabic');

    function getFilsAsText(fils) {
        if (!fils || fils <= 0) return 'صفر جنيه';
        const amountInKD = fils / 1000;
        try {
            return new Tafgeet(amountInKD, 'EGP').parse();
        } catch (e) {
            return `${amountInKD} جنيه`;
        }
    }

    function formatFinancialAmount(filsAmount) {
        const fils = Math.max(0, Math.round(filsAmount || 0));
        const kd = Number((fils / 1000).toFixed(3));
        return {
            kd: kd,
            fils: fils,
            text: getFilsAsText(fils),
        };
    }

    // Build date filter
    const dateFilter = {};
    const date = req.query.date ? String(req.query.date).trim() : null;
    const startDate = req.query.startDate ? String(req.query.startDate).trim() : null;
    const endDate = req.query.endDate ? String(req.query.endDate).trim() : null;
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    const category = req.query.orderCategory ? String(req.query.orderCategory).trim().toLowerCase() : 'all';

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
        const to = new Date(year, month, 1);
        dateFilter.createdAt = { $gte: from, $lt: to };
    } else if (!isNaN(year)) {
        const from = new Date(year, 0, 1);
        const to = new Date(year + 1, 0, 1);
        dateFilter.createdAt = { $gte: from, $lt: to };
    }

    const completedStatuses = ['completed', 'delivered', 'Completed', 'Delivered'];
    const matchStage = {
        status: { $in: completedStatuses },
        ...dateFilter,
    };

    const commissionCfg = await getCachedRepCommission().catch(() => ({
        deliveryRepCommissionPct: 100,
        businessRepCommissionPct: 100,
    }));

    const deliveryRepCommissionPct = commissionCfg?.deliveryRepCommissionPct ?? 100;
    const businessRepCommissionPct = commissionCfg?.businessRepCommissionPct ?? 100;

    // Single-pass high performance MongoDB Aggregation Facet pipeline
    const aggResult = await Order.aggregate([
        { $match: matchStage },
        {
            $project: {
                isBusinessOrder: 1,
                orderCategory: 1,
                deliveryPriceFils: {
                    $let: {
                        vars: {
                            dp: { $ifNull: ['$totalDeliveryPrice', { $ifNull: ['$deliveryPrice', 0] }] }
                        },
                        in: {
                            $cond: [
                                { $gt: ['$$dp', 0] },
                                {
                                    $cond: [
                                        { $lt: ['$$dp', 100] },
                                        { $round: [{ $multiply: ['$$dp', 1000] }] },
                                        { $round: ['$$dp'] }
                                    ]
                                },
                                0
                            ]
                        }
                    }
                },
                totalPriceFilsRaw: {
                    $cond: [
                        { $gt: ['$totalPrice', 0] },
                        {
                            $cond: [
                                { $lt: ['$totalPrice', 100] },
                                { $round: [{ $multiply: ['$totalPrice', 1000] }] },
                                { $round: ['$totalPrice'] }
                            ]
                        },
                        0
                    ]
                }
            }
        },
        {
            $project: {
                isBusinessOrder: 1,
                orderCategory: 1,
                deliveryPriceFils: 1,
                totalPriceFils: {
                    $cond: [
                        { $gt: ['$totalPriceFilsRaw', 0] },
                        '$totalPriceFilsRaw',
                        '$deliveryPriceFils'
                    ]
                }
            }
        },
        {
            $facet: {
                delivery: [
                    {
                        $group: {
                            _id: null,
                            completedOrdersCount: { $sum: 1 },
                            totalOrdersAmountFils: { $sum: '$totalPriceFils' },
                            totalDeliveryFeesFils: { $sum: '$deliveryPriceFils' }
                        }
                    }
                ]
            }
        }
    ]);

    const facetData = aggResult[0] || {};
    const deliveryRaw = (facetData.delivery && facetData.delivery[0]) || { completedOrdersCount: 0, totalOrdersAmountFils: 0, totalDeliveryFeesFils: 0 };

    // ── Delivery Breakdown ──
    const delCount = deliveryRaw.completedOrdersCount || 0;
    const delOrdersAmountFils = deliveryRaw.totalOrdersAmountFils || 0;
    const delDeliveryFeesFils = deliveryRaw.totalDeliveryFeesFils || 0;
    const delDriversShareFils = Math.round((delDeliveryFeesFils * deliveryRepCommissionPct) / 100);
    const delCompanyNetProfitFils = delDeliveryFeesFils - delDriversShareFils;

    const deliveryFormatted = {
        completedOrdersCount: delCount,
        commissionPct: deliveryRepCommissionPct,
        totalOrdersAmount: formatFinancialAmount(delOrdersAmountFils),
        totalDeliveryFees: formatFinancialAmount(delDeliveryFeesFils),
        driversShare: formatFinancialAmount(delDriversShareFils),
        companyNetProfit: formatFinancialAmount(delCompanyNetProfitFils),
    };

    const businessFormatted = {
        completedOrdersCount: 0,
        commissionPct: deliveryRepCommissionPct,
        totalOrdersAmount: formatFinancialAmount(0),
        totalDeliveryFees: formatFinancialAmount(0),
        driversShare: formatFinancialAmount(0),
        companyNetProfit: formatFinancialAmount(0),
    };

    const totalFormatted = {
        totalCompletedOrdersCount: delCount,
        totalOrdersAmount: formatFinancialAmount(delOrdersAmountFils),
        totalDeliveryFees: formatFinancialAmount(delDeliveryFeesFils),
        totalDriversShare: formatFinancialAmount(delDriversShareFils),
        totalCompanyNetProfit: formatFinancialAmount(delCompanyNetProfitFils),
    };

    return res.status(200).json({
        success: true,
        filter: {
            date: date || null,
            startDate: startDate || null,
            endDate: endDate || null,
            month: isNaN(month) ? null : month,
            year: isNaN(year) ? null : year,
            orderCategory: 'delivery',
            deliveryRepCommissionPct,
        },
        delivery: deliveryFormatted,
        business: businessFormatted,
        total: totalFormatted,
    });
});

/**
 * GET /api/orders/active
 * جلب الطلبات النشطة للعميل الحالي (waiting / accepted / delivering / ...)
 * وفحص إمكانية إنشاء طلب جديد (الحد الأقصى 2)
 */
const getActiveOrders = asyncHandler(async (req, res) => {
    const userId = (req.user?.id || req.user?._id || '').toString().trim();
    if (!userId) {
        return res.status(401).json({ message: 'User not authenticated' });
    }

    const MAX_ALLOWED = 2;
    const activeStatuses = [
        'waiting',
        'accepted',
        'delivering',
        'confirmed',
        'processing',
        'shipped',
        'pending',
    ];

    const commissionCfg = await getCachedRepCommission().catch(() => null);
    const mongoose = require('mongoose');
    const userObjId = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : null;

    const orders = await Order.collection.find({
        $or: [
            { clientId: String(userId) },
            ...(userObjId ? [{ clientId: userObjId }] : []),
            { userId: String(userId) },
            ...(userObjId ? [{ userId: userObjId }] : []),
        ],
        isBusinessOrder: { $ne: true },
        orderCategory: { $ne: 'business' },
        status: { $in: activeStatuses },
    })
        .sort({ createdAt: -1, orderId: -1 })
        .toArray();

    const allFormatted = [];
    const seenKeys = new Set();

    for (const doc of orders) {
        const mongoId = doc._id ? doc._id.toString() : '';
        const ordId = doc.orderId != null ? String(doc.orderId) : '';

        if (
            (mongoId && seenKeys.has(`mongo_${mongoId}`)) ||
            (ordId && seenKeys.has(`ord_${ordId}`))
        ) {
            continue;
        }

        if (mongoId) seenKeys.add(`mongo_${mongoId}`);
        if (ordId) seenKeys.add(`ord_${ordId}`);

        const formatted = formatOrder(req, doc, commissionCfg);
        if (formatted) {
            formatted.isBusinessOrder = false;
            formatted.orderCategory = doc.orderCategory || formatted.orderCategory || 'delivery';
            allFormatted.push(formatted);
        }
    }

    let enrichedOrders = await enrichOrdersWithRepData(req, allFormatted);
    enrichedOrders = await enrichOrdersWithClientData(req, enrichedOrders);
    enrichedOrders = await enrichOrdersWithVehicleData(req, enrichedOrders);
    enrichedOrders = await enrichOrdersWithDeliveryPhotos(req, enrichedOrders);

    enrichedOrders.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const activeOrders = enrichedOrders.map((order) => {
        let fromLatitude = 0;
        let fromLongitude = 0;
        let toLatitude = 0;
        let toLongitude = 0;

        if (Array.isArray(order.tasks) && order.tasks.length > 0) {
            const firstTask = order.tasks[0];
            fromLatitude = Number(firstTask.fromLatitude) || 0;
            fromLongitude = Number(firstTask.fromLongitude) || 0;
            toLatitude = Number(firstTask.toLatitude) || 0;
            toLongitude = Number(firstTask.toLongitude) || 0;
        }

        return {
            ...order,
            id: (order.orderId || order._id || '').toString(),
            _id: (order._id || order.orderId || '').toString(),
            orderId: (order.orderId || order._id || '').toString(),
            isBusinessOrder: false,
            orderCategory: order.orderCategory || 'delivery',
            fromLatitude,
            fromLongitude,
            toLatitude,
            toLongitude,
            destinationsData: order.destinationsData || (order.tasks && order.tasks[0] ? order.tasks[0].destinationsData : null),
            allLocationsInOrder: order.allLocationsInOrder || (order.tasks && order.tasks[0] ? order.tasks[0].allLocationsInOrder : null),
        };
    });

    const activeCount = activeOrders.length;
    const canCreateNew = activeCount < MAX_ALLOWED;

    return res.status(200).json({
        activeOrders: activeOrders.slice(0, MAX_ALLOWED),
        canCreateNew,
        maxAllowed: MAX_ALLOWED,
        activeCount,
    });
});

module.exports = {
    listOrders,
    listOrdersByUserId,
    listOrdersByRepresentativeId,
    listWaitingOrders,
    createOrder,
    getOrderById,
    updateOrderStatus,
    getOrderStatus,
    cancelOrder,
    getOrderRoute,
    acceptOrder,
    releaseOrder,
    confirmArrival,
    markClientDelayed,
    searchOrderByNumber,
    getAdminOrderFinancialStats,
    enrichOrdersWithDeliveryPhotos,
    formatOrder,
    getActiveOrders,
};



