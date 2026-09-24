/**
 * notifyClient.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Helper that sends an FCM push notification to a client (by their MongoDB
 * userId).  Non-blocking and never throws – all errors are only logged.
 */

const FcmToken = require('../models/FcmToken');
const Notification = require('../models/Notification');
const admin   = require('firebase-admin');
const { getFirebaseApp, isInvalidTokenError } = require('./firebaseService');

/**
 * Automatically decodes Mojibake text (double-encoded UTF-8 saved as Latin1/Windows-1252)
 * into clean, readable Arabic text.
 */
function fixMojibake(text) {
    if (!text || typeof text !== 'string') return text;
    if (/[\u00C0-\u00FF]/.test(text)) {
        try {
            const decoded = Buffer.from(text, 'latin1').toString('utf8');
            if (decoded && !decoded.includes('\uFFFD')) {
                return decoded;
            }
        } catch (e) {}
    }
    return text;
}

/**
 * @param {string} userId   – MongoDB _id of the user to notify
 * @param {string} title    – Notification title
 * @param {string} body     – Notification body
 * @param {object} [data]   – Optional string key-value data payload for Flutter
 */
async function notifyClient(userId, title, body, data = {}) {
    if (!userId) return;

    title = fixMojibake(title);
    body  = fixMojibake(body);

    try {
        // 1. Save to Database
        await Notification.create({
            userId,
            title,
            body,
            data,
        });

        const record = await FcmToken.findOne({
            $or: [{ userId: String(userId) }, { userId: userId }],
        }).lean();
        if (!record?.fcmToken) {
            console.log(`[FCM] no token for userId=${userId} — skipping push (saved to DB)`);
            return;
        }

        // Ensure all data values are strings (FCM requirement)
        const stringData = {};
        for (const [k, v] of Object.entries(data)) {
            if (v != null) stringData[k] = String(v);
        }

        getFirebaseApp(); // ensure initialized
        const message = {
            token: record.fcmToken,
            notification: { title, body },
            data: stringData,          // ← key for Flutter foreground handler
            android: {
                priority: 'high',
                notification: {
                    channelId: 'mashawer_notifications',
                    priority: 'max',
                    defaultSound: true,
                },
            },
            apns: { payload: { aps: { sound: 'default' } } },
        };

        let messageId;
        try {
            messageId = await admin.messaging().send(message);
            console.log(`[FCM] ✓ sent to userId=${userId} → ${messageId}`);
        } catch (err) {
            const code = err.errorInfo?.code || '';
            if (isInvalidTokenError(code)) {
                await FcmToken.deleteOne({ userId });
                console.warn(`[FCM] removed stale token for userId=${userId}`);
            } else {
                console.warn(`[FCM] send failed for userId=${userId}: ${err.message}`);
            }
        }
    } catch (err) {
        console.error(`[FCM] unexpected error notifying userId=${userId}:`, err.message);
    }
}

module.exports = { notifyClient };
