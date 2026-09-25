const mongoose = require('mongoose');
const { User } = require('./User');
const { isBanned } = require('../services/bannedDeviceService');

/**
 * Normalizes user role string for reliable comparison
 */
function normalizeRole(role) {
    if (!role) return 'normaluser';
    const clean = role.toString().trim().toLowerCase();
    if (clean === 'client' || clean === 'normaluser' || clean === '') {
        return 'normaluser';
    }
    if (clean === 'representative' || clean === 'driver') {
        return 'representative';
    }
    if (clean === 'administration') return 'administration';
    if (clean === 'admin') return 'admin';
    return clean;
}

/**
 * Middleware to check if the user is blocked, suspended, deleted, or if their userType has changed.
 * Must be called after verifyToken (which sets req.user).
 */
const checkUserStatus = async (req, res, next) => {
    try {
        if (!req.user || !req.user.id) {
            return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized: User not authenticated' });
        }

        if (process.env.TEST_MODE === 'true' && mongoose.connection.readyState !== 1) {
            return next();
        }

        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(401).json({ code: 'USER_DELETED', message: 'حسابك غير موجود أو تم حذفه' });
        }

        // Check if password was changed after this token was issued (Session Revocation Across All Devices)
        if (user.passwordChangedAt && req.user?.iat) {
            const passwordChangedTimestamp = Math.floor(user.passwordChangedAt.getTime() / 1000);
            if (req.user.iat < passwordChangedTimestamp) {
                return res.status(401).json({
                    code: 'PASSWORD_CHANGED',
                    message: 'تم تغيير كلمة المرور مؤخراً. يرجى إعادة تسجيل الدخول.',
                });
            }
        }

        // Check if user account is suspended or blocked by admin
        if (user.isSuspended === true || user.status === 'blocked') {
            return res.status(403).json({
                code: 'ACCOUNT_SUSPENDED',
                message: 'تم إيقاف حسابك من قبل الإدارة. يرجى التواصل مع الدعم الفني.',
            });
        }

        // Extract & persist physical hardware device ID
        const fcmToken = req.headers['fcm-token'] || req.headers['x-fcm-token'];
        const deviceId = req.headers['x-device-id'] || req.body?.deviceId;
        if (deviceId && user.deviceId !== deviceId) {
            user.deviceId = deviceId;
            await user.save().catch((err) => console.warn('[checkUserStatus] Failed to update user.deviceId:', err.message));
        }

        // Master BannedDevice System Check (Device ID / Phone / Email / FCM Token)
        const banCheck = await isBanned({ phone: user.phone, fcmToken, deviceId: user.deviceId || deviceId, email: user.email });

        if (banCheck.isBanned) {
            return res.status(403).json({
                code: 'DEVICE_BLOCKED',
                message: 'عذراً، هذا الجهاز أو رقم الهاتف محظور من استخدام التطبيق. يرجى التواصل مع الدعم الفني.',
            });
        }

        const dbRole = normalizeRole(user.userType);
        const isUserAdmin = !!user.isAdmin || dbRole === 'admin';

        // Header check: Compare client's session userType with actual DB userType
        const clientUserTypeHeader = req.headers['x-user-type'] || req.headers['x-current-role'];
        if (clientUserTypeHeader && !isUserAdmin) {
            const clientRole = normalizeRole(clientUserTypeHeader);
            if (clientRole !== dbRole) {
                console.warn(`[checkUserStatus] ⚠️ User ${user._id} role mismatch! Client says: '${clientRole}', DB has: '${dbRole}'. Forcing logout.`);
                return res.status(403).json({
                    code: 'USER_TYPE_CHANGED',
                    message: 'تم تغيير نوع/صلاحيات حسابك من قبل الإدارة. يرجى إعادة تسجيل الدخول.',
                    actualUserType: user.userType,
                });
            }
        }

        // Attach the full user object to the request
        req.fullUser = user;
        if (req.user) {
            req.user.isAdmin = isUserAdmin;
            const rawType = user.userType || req.user.userType || 'NormalUser';
            req.user.userType = typeof rawType === 'string' ? rawType.trim() : rawType;
        }

        next();
    } catch (error) {
        console.error('[checkUserStatus] Error:', error.message);
        res.status(500).json({ message: 'Internal server error while checking user status' });
    }
};

module.exports = checkUserStatus;

