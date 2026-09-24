const asyncHandler = require('express-async-handler');
const { isBanned } = require('../services/bannedDeviceService');

/**
 * Middleware to check if incoming user request originates from a banned device or phone number.
 * Extract identifiers from body or custom headers.
 */
const checkBannedDevice = asyncHandler(async (req, res, next) => {
    const phone = req.body?.phone || req.body?.phoneNumber || req.user?.phone || req.headers['x-phone'];
    const fcmToken = req.body?.fcmToken || req.body?.token || req.headers['fcm-token'] || req.headers['x-fcm-token'];
    const deviceId = req.body?.deviceId || req.headers['x-device-id'];
    const email = req.body?.email || req.user?.email || req.headers['x-email'];

    const banCheck = await isBanned({ phone, fcmToken, deviceId, email });

    if (banCheck.isBanned) {
        return res.status(403).json({
            code: 'DEVICE_BLOCKED',
            matchedField: banCheck.matchedField,
            message: 'عذراً، هذا الجهاز أو رقم الهاتف محظور من إنشاء حسابات جديدة أو الاستخدام. يرجى التواصل مع الدعم الفني.',
        });
    }

    next();
});

module.exports = { checkBannedDevice };
