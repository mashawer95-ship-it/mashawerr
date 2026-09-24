const admin = require('firebase-admin');

let app;

function getFirebaseApp() {
    if (admin.apps.length > 0) {
        app = admin.app();
        return app;
    }

    if (!app) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        console.log('ENV:', raw ? 'OK' : 'MISSING');

        let serviceAccount;
        
        if (raw && String(raw).trim()) {
            serviceAccount = JSON.parse(raw);
        } else {
            // Fallback to local file if env var is missing
            const fs = require('fs');
            const path = require('path');
            const localPath = path.join(__dirname, '../firebase-service-account.json');
            
            if (fs.existsSync(localPath)) {
                console.log('Using local firebase-service-account.json file');
                serviceAccount = JSON.parse(fs.readFileSync(localPath, 'utf8'));
            } else {
                throw new Error(
                    'Firebase credentials missing! Please either set FIREBASE_SERVICE_ACCOUNT env var OR create firebase-service-account.json in the root folder.'
                );
            }
        }

        if (typeof serviceAccount.private_key === 'string') {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }

        app = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });

        console.log('Firebase Admin SDK initialized');
    }
    return app;
}

/** FCM allows at most 500 registration tokens per sendEachForMulticast / multicast message. */
const FCM_MULTICAST_MAX = 500;

/**
 * Send a push notification to a single FCM token.
 * @param {string} token   - FCM device token
 * @param {string} title   - Notification title
 * @param {string} body    - Notification body
 * @returns {{ success: boolean, messageId?: string, error?: string }}
 */
async function sendToToken(token, title, body) {
    getFirebaseApp();
    const message = {
        token,
        notification: { title, body },
        android: { priority: 'high' },
        apns: { payload: { aps: { sound: 'default' } } },
    };

    try {
        const messageId = await admin.messaging().send(message);
        console.log(`[FCM] ✓ sent to token ${token.slice(0, 20)}… → ${messageId}`);
        return { success: true, messageId };
    } catch (err) {
        console.error(`[FCM] ✗ failed for token ${token.slice(0, 20)}… → ${err.message}`);
        return { success: false, error: err.message, code: err.errorInfo?.code };
    }
}

/**
 * Send a notification to multiple tokens using sendEachForMulticast.
 * Returns per-token results and lists of invalid tokens for cleanup.
 * @param {string[]} tokens
 * @param {string}   title
 * @param {string}   body
 * @returns {{ successCount: number, failureCount: number, invalidTokens: string[] }}
 */
async function sendToMultiple(tokens, title, body) {
    if (!tokens || tokens.length === 0) {
        return { successCount: 0, failureCount: 0, invalidTokens: [] };
    }

    getFirebaseApp();

    let successCount = 0;
    let failureCount = 0;
    const invalidTokens = [];

    for (let offset = 0; offset < tokens.length; offset += FCM_MULTICAST_MAX) {
        const chunk = tokens.slice(offset, offset + FCM_MULTICAST_MAX);
        const message = {
            tokens: chunk,
            notification: { title, body },
            android: { priority: 'high' },
            apns: { payload: { aps: { sound: 'default' } } },
        };

        let response;
        try {
            response = await admin.messaging().sendEachForMulticast(message);
        } catch (err) {
            console.error(`[FCM] sendEachForMulticast batch failed (offset ${offset}, size ${chunk.length}):`, err.message);
            failureCount += chunk.length;
            continue;
        }

        response.responses.forEach((res, idx) => {
            const globalIdx = offset + idx;
            if (!res.success) {
                const code = res.error?.errorInfo?.code || res.error?.code || '';
                console.warn(
                    `[FCM] ✗ token[${globalIdx}] ${chunk[idx].slice(0, 20)}… → ${res.error?.message}`
                );

                const isInvalidToken =
                    code.includes('registration-token-not-registered') ||
                    code.includes('invalid-registration-token') ||
                    code.includes('messaging/invalid-argument');

                if (isInvalidToken) {
                    invalidTokens.push(chunk[idx]);
                }
            } else {
                console.log(`[FCM] ✓ token[${globalIdx}] ${chunk[idx].slice(0, 20)}… → ${res.messageId}`);
            }
        });

        successCount += response.successCount;
        failureCount += response.failureCount;
        console.log(
            `[FCM] batch ${offset / FCM_MULTICAST_MAX + 1} — success: ${response.successCount}, failure: ${response.failureCount}`
        );
    }

    console.log(`[FCM] multicast done (all batches) — success: ${successCount}, failure: ${failureCount}`);

    return {
        successCount,
        failureCount,
        invalidTokens,
    };
}

/** Check whether an FCM error code represents an invalid / unregistered token. */
function isInvalidTokenError(errorCode) {
    return (
        errorCode === 'messaging/registration-token-not-registered' ||
        errorCode === 'messaging/invalid-registration-token' ||
        errorCode === 'messaging/invalid-argument'
    );
}

module.exports = { sendToToken, sendToMultiple, isInvalidTokenError, getFirebaseApp };
