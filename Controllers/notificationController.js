const asyncHandler = require('express-async-handler');
const FcmToken = require('../models/FcmToken');
const Notification = require('../models/Notification');
const { sendToToken, sendToMultiple, isInvalidTokenError } = require('../services/firebaseService');
const { isBanned } = require('../services/bannedDeviceService');

/**
 * POST /api/notifications/save-token
 * Body: { userId, token }
 * Creates a new FCM token record or updates the token if userId already exists.
 */
const saveToken = asyncHandler(async (req, res) => {
    const { userId, token } = req.body;
    const deviceId = req.body?.deviceId || req.headers['x-device-id'];

    if (!userId || !token) {
        return res.status(400).json({ message: 'userId and token are required' });
    }

    const banCheck = await isBanned({ fcmToken: token, deviceId });
    if (banCheck.isBanned) {
        return res.status(403).json({
            code: 'DEVICE_BLOCKED',
            message: 'عذراً، هذا الجهاز محظور من الاستخدام.',
        });
    }

    const record = await FcmToken.findOneAndUpdate(
        { userId },
        { fcmToken: token },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const wasNew = !record.createdAt || Date.now() - record.createdAt.getTime() < 2000;
    console.log(`[Token] ${wasNew ? 'created' : 'updated'} for userId=${userId}`);

    res.status(200).json({
        message: wasNew ? 'Token saved successfully' : 'Token updated successfully',
        userId: record.userId,
        fcmToken: record.fcmToken,
    });
});

/**
 * GET /api/notifications/users
 * Returns all stored userId + fcmToken pairs (admin use).
 */
const getAllUsers = asyncHandler(async (req, res) => {
    const users = await FcmToken.find({}, { userId: 1, fcmToken: 1, _id: 0 }).lean();
    res.status(200).json({ count: users.length, users });
});

/**
 * POST /api/notifications/send-to-user
 * Body: { userId, title, body }
 * Sends a push notification to a single user by userId.
 */
const sendToUser = asyncHandler(async (req, res) => {
    const { userId, title, body } = req.body;

    if (!userId || !title || !body) {
        return res.status(400).json({ message: 'userId, title, and body are required' });
    }

    const record = await FcmToken.findOne({ userId });
    if (!record) {
        return res.status(404).json({ message: `No token found for userId: ${userId}` });
    }

    // Save to Database
    await Notification.create({
        userId,
        title,
        body,
        data: {},
    });

    const result = await sendToToken(record.fcmToken, title, body);

    if (!result.success) {
        if (isInvalidTokenError(result.code)) {
            await FcmToken.deleteOne({ userId });
            console.warn(`[Token] removed invalid token for userId=${userId}`);
            return res.status(410).json({
                message: 'Notification failed: invalid or unregistered token. Token removed.',
                error: result.error,
            });
        }
        return res.status(500).json({ message: 'Notification failed', error: result.error });
    }

    res.status(200).json({ message: 'Notification sent successfully', messageId: result.messageId });
});

/**
 * POST /api/notifications/send-to-all
 * Body: { title, body }
 * Header: x-admin-key required
 * Sends a notification to all registered tokens using sendEachForMulticast.
 * Invalid tokens are automatically removed from the database.
 */
const sendToAll = asyncHandler(async (req, res) => {
    const { title, body } = req.body;

    if (!title || !body) {
        return res.status(400).json({ message: 'title and body are required' });
    }

    const records = await FcmToken.find({}, { userId: 1, fcmToken: 1 }).lean();

    if (records.length === 0) {
        return res.status(200).json({ message: 'No users registered for notifications', successCount: 0, failureCount: 0 });
    }

    // Save to Database for all users
    const notificationsToSave = records.map(r => ({
        userId: r.userId,
        title,
        body,
        data: {},
    }));
    await Notification.insertMany(notificationsToSave);

    const tokens = records.map((r) => r.fcmToken);

    let result;
    try {
        result = await sendToMultiple(tokens, title, body);
    } catch (err) {
        console.error('[send-to-all] broadcast failed:', err);
        return res.status(500).json({
            message: 'Broadcast failed',
            error: err.message || String(err),
        });
    }

    if (result.invalidTokens.length > 0) {
        const deleteResult = await FcmToken.deleteMany({ fcmToken: { $in: result.invalidTokens } });
        console.warn(`[Token] removed ${deleteResult.deletedCount} invalid token(s)`);
    }

    res.status(200).json({
        message: 'Broadcast complete',
        totalRecipients: records.length,
        successCount: result.successCount,
        failureCount: result.failureCount,
        invalidTokensRemoved: result.invalidTokens.length,
    });
});

/**
 * DELETE /api/notifications/delete-user/:userId
 * Removes a user's FCM token from the database.
 */
const deleteUser = asyncHandler(async (req, res) => {
    const { userId } = req.params;

    const record = await FcmToken.findOneAndDelete({ userId });
    if (!record) {
        return res.status(404).json({ message: `No token found for userId: ${userId}` });
    }

    console.log(`[Token] deleted token for userId=${userId}`);
    res.status(200).json({ message: 'User token deleted successfully', userId });
});

/**
 * POST /api/notifications/test-notify
 * Body: { userId, title?, body? }
 * Diagnostic endpoint — checks Firebase, finds token, sends test notification.
 * Returns step-by-step diagnostic info.
 */
const testNotify = asyncHandler(async (req, res) => {
    const { userId, title = '🔔 اختبار إشعار', body = 'الإشعارات تعمل بشكل صحيح ✅' } = req.body;

    if (!userId) {
        return res.status(400).json({ message: 'userId is required' });
    }

    const diagnostic = { userId, steps: [] };

    // Step 1: Check Firebase env var or local file
    const fs = require('fs');
    const path = require('path');
    const firebaseEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
    const localPath = path.join(__dirname, '../firebase-service-account.json');
    
    if (firebaseEnv && String(firebaseEnv).trim()) {
        diagnostic.steps.push({ step: 1, status: '✅ OK', message: 'FIREBASE_SERVICE_ACCOUNT env var found' });
    } else if (fs.existsSync(localPath)) {
        diagnostic.steps.push({ step: 1, status: '✅ OK', message: 'firebase-service-account.json file found' });
    } else {
        diagnostic.steps.push({ step: 1, status: '❌ FAILED', message: 'Missing Firebase credentials! No env var and no firebase-service-account.json file found.' });
        return res.status(500).json(diagnostic);
    }

    // Step 2: Check FCM token in DB
    const record = await FcmToken.findOne({ userId }).lean();
    if (!record?.fcmToken) {
        diagnostic.steps.push({ step: 2, status: '❌ FAILED', message: `No FCM token found for userId=${userId} — user must log in first to register token` });
        return res.status(404).json(diagnostic);
    }
    diagnostic.steps.push({ step: 2, status: '✅ OK', message: `FCM token found: ${record.fcmToken.slice(0, 30)}…` });

    // Step 3: Send test notification
    try {
        const { getFirebaseApp } = require('../services/firebaseService');
        const admin = require('firebase-admin');
        getFirebaseApp();

        const message = {
            token: record.fcmToken,
            notification: { title, body },
            data: { type: 'test', orderId: '0' },
            android: {
                priority: 'high',
                notification: { channelId: 'mashawer_notifications', priority: 'max', defaultSound: true },
            },
            apns: { payload: { aps: { sound: 'default' } } },
        };

        const messageId = await admin.messaging().send(message);
        diagnostic.steps.push({ step: 3, status: '✅ SENT', message: `Notification sent! messageId=${messageId}` });
        return res.status(200).json({ ...diagnostic, result: 'Notification sent successfully', messageId });
    } catch (err) {
        diagnostic.steps.push({ step: 3, status: '❌ FAILED', message: `FCM send error: ${err.message}`, code: err.errorInfo?.code });
        return res.status(500).json(diagnostic);
    }
});

/**
 * @description Get all notifications for the currently logged in user
 * @route GET /api/notifications/my-notifications
 * @access Private
 */
const getMyNotifications = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const notifications = await Notification.find({ userId }).sort({ createdAt: -1 });
    res.status(200).json(notifications);
});

/**
 * @description Delete all notifications for the currently logged in user
 * @route DELETE /api/notifications/my-notifications
 * @access Private
 */
const deleteAllMyNotifications = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    await Notification.deleteMany({ userId });
    res.status(200).json({ message: 'All notifications deleted successfully' });
});

/**
 * @description Delete a specific notification by ID
 * @route DELETE /api/notifications/:id
 * @access Private
 */
const deleteNotificationById = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const notificationId = req.params.id;

    const notification = await Notification.findOneAndDelete({ _id: notificationId, userId });
    
    if (!notification) {
        return res.status(404).json({ message: 'Notification not found or you do not have permission to delete it' });
    }

    res.status(200).json({ message: 'Notification deleted successfully' });
});

/**
 * @description Mark a specific notification as read
 * @route PATCH /api/notifications/:id/read
 * @access Private
 */
const markNotificationAsRead = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const notificationId = req.params.id;

    const notification = await Notification.findOneAndUpdate(
        { _id: notificationId, userId },
        { isRead: true },
        { new: true }
    );
    
    if (!notification) {
        return res.status(404).json({ message: 'Notification not found or you do not have permission to update it' });
    }

    res.status(200).json(notification);
});

module.exports = { 
    saveToken, 
    getAllUsers, 
    sendToUser, 
    sendToAll, 
    deleteUser, 
    testNotify,
    getMyNotifications,
    deleteAllMyNotifications,
    deleteNotificationById,
    markNotificationAsRead
};
