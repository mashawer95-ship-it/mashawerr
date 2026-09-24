const BannedDevice = require('../models/BannedDevice');
const { redisSet, redisGet, redisDel } = require('../config/redis');
const logger = require('../utils/logger');

// Redis Key Prefix Constants
const REDIS_BAN_TTL = 365 * 24 * 60 * 60; // 1 year TTL in Redis (refreshed on check)

/**
 * Clean & normalize phone number for exact comparison
 */
function normalizePhone(phone) {
    if (!phone) return null;
    return String(phone).replace(/\s+/g, '').replace(/[^\d+]/g, '');
}

/**
 * Ban user hardware/contact identifiers
 * @param {Object} params
 * @param {string} [params.phone]
 * @param {string} [params.fcmToken]
 * @param {string} [params.deviceId]
 * @param {string} [params.email]
 * @param {string} [params.userId]
 * @param {string} [params.userName]
 * @param {string} [params.profileImage]
 * @param {string} [params.userType]
 * @param {string} [params.reason]
 * @param {string} [params.adminId]
 */
async function banIdentifier({ phone, fcmToken, deviceId, email, userId, userName, profileImage, userType, reason = 'ACCOUNT_DELETED_BY_ADMIN', adminId = 'SYSTEM_ADMIN' }) {
    const normPhone = normalizePhone(phone);
    const normEmail = email ? String(email).trim().toLowerCase() : null;
    const cleanFcm = fcmToken ? String(fcmToken).trim() : null;
    const cleanDevId = deviceId ? String(deviceId).trim() : null;

    if (!normPhone && !cleanFcm && !cleanDevId && !normEmail && !userId) {
        logger.warn('[bannedDeviceService] No valid identifiers supplied for banIdentifier');
        return null;
    }

    try {
        // 1. Save or update persistent record in MongoDB
        const record = await BannedDevice.create({
            phone: normPhone,
            fcmToken: cleanFcm,
            deviceId: cleanDevId,
            email: normEmail,
            originalUserId: userId ? String(userId) : null,
            userName: userName ? String(userName).trim() : null,
            profileImage: profileImage ? String(profileImage).trim() : null,
            userType: userType ? String(userType).trim() : null,
            reason,
            bannedBy: adminId ? String(adminId) : 'SYSTEM_ADMIN',
            isActive: true,
        });

        // 2. Populate Redis cache for sub-millisecond checks
        const redisPromises = [];
        if (normPhone)  redisPromises.push(redisSet(`banned:phone:${normPhone}`, '1', REDIS_BAN_TTL));
        if (cleanFcm)   redisPromises.push(redisSet(`banned:fcm:${cleanFcm}`, '1', REDIS_BAN_TTL));
        if (cleanDevId) redisPromises.push(redisSet(`banned:dev:${cleanDevId}`, '1', REDIS_BAN_TTL));
        if (normEmail)  redisPromises.push(redisSet(`banned:email:${normEmail}`, '1', REDIS_BAN_TTL));

        await Promise.all(redisPromises).catch((err) => {
            logger.warn('[bannedDeviceService] Failed to set Redis ban keys:', err.message);
        });

        logger.info(`[bannedDeviceService] Successfully banned identifiers for userId=${userId}: userName=${userName || 'N/A'}, phone=${normPhone}, fcm=${cleanFcm ? cleanFcm.slice(0, 15) + '...' : 'N/A'}`);
        return record;
    } catch (err) {
        logger.error('[bannedDeviceService] Error in banIdentifier:', err.message);
        throw err;
    }
}

/**
 * Unban a previously banned device/identifier by ID, phone, email, userId, or deviceId
 */
async function unbanIdentifier(query) {
    if (!query) return { success: false, message: 'Identifier required' };
    try {
        const cleanQuery = String(query).trim();
        const normPhone = normalizePhone(cleanQuery);
        const normEmail = cleanQuery.includes('@') ? cleanQuery.toLowerCase() : null;

        const filterOr = [];
        if (cleanQuery.match(/^[0-9a-fA-F]{24}$/)) {
            filterOr.push({ _id: cleanQuery });
            filterOr.push({ originalUserId: cleanQuery });
        }
        if (normPhone) filterOr.push({ phone: normPhone });
        if (normEmail) filterOr.push({ email: normEmail });
        filterOr.push({ deviceId: cleanQuery });
        filterOr.push({ fcmToken: cleanQuery });

        // If query is a userId, find FCM tokens for this user
        if (cleanQuery.match(/^[0-9a-fA-F]{24}$/)) {
            try {
                const { FcmToken } = require('../models/FcmToken');
                const fcmRecords = await FcmToken.find({ userId: cleanQuery }).select('fcmToken').lean();
                fcmRecords.forEach((f) => {
                    if (f.fcmToken) filterOr.push({ fcmToken: f.fcmToken });
                });
            } catch (_) {}
        }

        const records = await BannedDevice.find({ $or: filterOr, isActive: true });

        if (records.length > 0) {
            const recordIds = records.map((r) => r._id);
            await BannedDevice.updateMany({ _id: { $in: recordIds } }, { $set: { isActive: false } });

            // Delete from Redis
            for (const rec of records) {
                const keys = [];
                if (rec.phone) keys.push(`banned:phone:${rec.phone}`);
                if (rec.fcmToken) keys.push(`banned:fcm:${rec.fcmToken}`);
                if (rec.deviceId) keys.push(`banned:dev:${rec.deviceId}`);
                if (rec.email) keys.push(`banned:email:${rec.email}`);

                if (keys.length > 0) {
                    await redisDel(...keys).catch((err) => logger.warn('[bannedDeviceService] Redis del error:', err.message));
                }
            }
        }

        // Clean direct Redis keys
        redisDel(
            `banned:dev:${cleanQuery}`,
            `banned:fcm:${cleanQuery}`,
            `banned:phone:${normPhone || cleanQuery}`,
            `banned:email:${normEmail || cleanQuery}`
        ).catch(() => {});

        // Reactivate associated User documents in MongoDB
        try {
            const { User } = require('../middlewares/User');
            const userConditions = [];
            if (cleanQuery.match(/^[0-9a-fA-F]{24}$/)) {
                userConditions.push({ _id: cleanQuery });
            }
            if (normPhone) userConditions.push({ phone: normPhone });
            if (normEmail) userConditions.push({ email: normEmail });
            userConditions.push({ deviceId: cleanQuery });

            for (const rec of records) {
                if (rec.originalUserId) userConditions.push({ _id: rec.originalUserId });
                if (rec.phone) userConditions.push({ phone: rec.phone });
                if (rec.email) userConditions.push({ email: rec.email });
                if (rec.deviceId) userConditions.push({ deviceId: rec.deviceId });
            }

            if (userConditions.length > 0) {
                const matchedUsers = await User.find({ $or: userConditions }).select('_id deviceId').lean();
                matchedUsers.forEach((u) => {
                    if (u.deviceId) userConditions.push({ deviceId: u.deviceId });
                });

                await User.updateMany(
                    { $or: userConditions },
                    { $set: { isSuspended: false, status: 'active' } }
                );
            }
        } catch (uErr) {
            logger.warn('[bannedDeviceService] Failed to reactivate users in unbanIdentifier:', uErr.message);
        }

        return { success: true, count: records.length };
    } catch (err) {
        logger.error('[bannedDeviceService] Error in unbanIdentifier:', err.message);
        throw err;
    }
}

/**
 * Ultra-fast check if phone, FCM token, device ID, or email is banned.
 * Priority Layer: MongoDB Single Source of Truth + Redis Sync & Self-Healing
 */
async function isBanned({ phone, fcmToken, deviceId, email }) {
    const normPhone = normalizePhone(phone);
    const normEmail = email ? String(email).trim().toLowerCase() : null;
    const cleanFcm = fcmToken ? String(fcmToken).trim() : null;
    const cleanDevId = deviceId ? String(deviceId).trim() : null;

    if (!normPhone && !cleanFcm && !cleanDevId && !normEmail) {
        return { isBanned: false };
    }

    // ── Layer 0: Admin Immunity Check (Admins can NEVER be banned) ──
    if (normEmail || normPhone) {
        try {
            const { User } = require('../middlewares/User');
            const adminQuery = [];
            if (normEmail) adminQuery.push({ email: normEmail });
            if (normPhone) adminQuery.push({ phone: normPhone });
            if (adminQuery.length > 0) {
                const foundUser = await User.findOne({ $or: adminQuery }).select('isAdmin userType').lean();
                if (foundUser && (foundUser.isAdmin || (foundUser.userType && foundUser.userType.toString().toLowerCase() === 'admin'))) {
                    return { isBanned: false };
                }
            }
        } catch (_) {}
    }

    // ── Layer 1: MongoDB Indexed Master Check ──
    const orConditions = [];
    if (normPhone)  orConditions.push({ phone: normPhone });
    if (cleanFcm)   orConditions.push({ fcmToken: cleanFcm });
    if (cleanDevId) orConditions.push({ deviceId: cleanDevId });
    if (normEmail)  orConditions.push({ email: normEmail });

    if (orConditions.length === 0) {
        return { isBanned: false };
    }

    const match = await BannedDevice.findOne({
        isActive: true,
        $or: orConditions,
    }).lean();

    if (!match) {
        // Clean up any stale Redis keys if MongoDB has no active ban
        const staleKeys = [];
        if (normPhone)  staleKeys.push(`banned:phone:${normPhone}`);
        if (cleanFcm)   staleKeys.push(`banned:fcm:${cleanFcm}`);
        if (cleanDevId) staleKeys.push(`banned:dev:${cleanDevId}`);
        if (normEmail)  staleKeys.push(`banned:email:${normEmail}`);
        if (staleKeys.length > 0) {
            redisDel(...staleKeys).catch(() => {});
        }
        return { isBanned: false };
    }



    let matchedField = 'identifier';
    if (normPhone && match.phone === normPhone) matchedField = 'phone';
    else if (cleanFcm && match.fcmToken === cleanFcm) matchedField = 'fcmToken';
    else if (cleanDevId && match.deviceId === cleanDevId) matchedField = 'deviceId';
    else if (normEmail && match.email === normEmail) matchedField = 'email';

    // Backfill Redis cache for verified active ban
    if (normPhone)  redisSet(`banned:phone:${normPhone}`, '1', REDIS_BAN_TTL).catch(() => {});
    if (cleanFcm)   redisSet(`banned:fcm:${cleanFcm}`, '1', REDIS_BAN_TTL).catch(() => {});
    if (cleanDevId) redisSet(`banned:dev:${cleanDevId}`, '1', REDIS_BAN_TTL).catch(() => {});
    if (normEmail)  redisSet(`banned:email:${normEmail}`, '1', REDIS_BAN_TTL).catch(() => {});

    return {
        isBanned: true,
        matchedField,
        reason: match.reason,
    };
}

module.exports = {
    banIdentifier,
    unbanIdentifier,
    isBanned,
    normalizePhone,
};
