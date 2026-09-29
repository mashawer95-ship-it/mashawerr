/**
 * payments/config/paymobConfig.js
 * Loads and validates Paymob configuration from environment variables.
 *
 * Fails fast at startup if any required secret is missing in production.
 * In development/test mode, missing non-critical values produce warnings only.
 *
 * NEVER import this file on the client or expose its values in responses.
 */

'use strict';

const { PAYMOB_BASE_URL } = require('../constants/paymentConstants');

/**
 * Load and validate Paymob configuration.
 * Called once at module load — throws if required vars are absent in production.
 */
function loadPaymobConfig() {
    const isProd = process.env.NODE_ENV === 'production';

    const secretKey       = process.env.PAYMOB_SECRET_KEY;
    const publicKey       = process.env.PAYMOB_PUBLIC_KEY;
    const hmacSecret      = process.env.PAYMOB_HMAC_SECRET;
    const integrationIdRaw = process.env.PAYMOB_INTEGRATION_ID;
    const baseUrl         = process.env.PAYMOB_BASE_URL || PAYMOB_BASE_URL.PRODUCTION;

    const missing = [];

    if (!secretKey)        missing.push('PAYMOB_SECRET_KEY');
    if (!hmacSecret)       missing.push('PAYMOB_HMAC_SECRET');
    if (!integrationIdRaw) missing.push('PAYMOB_INTEGRATION_ID');
    if (!publicKey)        missing.push('PAYMOB_PUBLIC_KEY');

    if (missing.length > 0) {
        const msg = `[PaymobConfig] Missing required environment variables: ${missing.join(', ')}`;
        if (isProd) {
            // Hard fail in production — do not start with a broken payment config.
            throw new Error(msg);
        } else {
            // Warn in dev/test — allow the server to start for non-payment routes.
            console.warn(`⚠️  ${msg}`);
        }
    }

    const integrationId = parseInt(integrationIdRaw, 10);
    if (integrationIdRaw && isNaN(integrationId)) {
        const msg = `[PaymobConfig] PAYMOB_INTEGRATION_ID must be a valid integer, got: "${integrationIdRaw}"`;
        if (isProd) throw new Error(msg);
        else console.warn(`⚠️  ${msg}`);
    }

    return Object.freeze({
        secretKey:     secretKey       || null,
        publicKey:     publicKey       || null,
        hmacSecret:    hmacSecret      || null,
        integrationId: integrationId   || null,
        baseUrl:       baseUrl.replace(/\/$/, ''), // strip trailing slash
    });
}

// Singleton — evaluated once when first imported.
const paymobConfig = loadPaymobConfig();

module.exports = paymobConfig;
