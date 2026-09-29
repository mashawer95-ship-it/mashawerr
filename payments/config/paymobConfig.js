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
        const msg = `[PaymobConfig] Paymob environment variables missing: ${missing.join(', ')}. Online payment features will return 503 until configured.`;
        console.warn(`⚠️  ${msg}`);
    }

    const integrationId = parseInt(integrationIdRaw, 10);
    if (integrationIdRaw && isNaN(integrationId)) {
        const msg = `[PaymobConfig] PAYMOB_INTEGRATION_ID must be a valid integer, got: "${integrationIdRaw}"`;
        console.warn(`⚠️  ${msg}`);
    }

    return Object.freeze({
        isConfigured:  missing.length === 0 && !isNaN(integrationId),
        secretKey:     secretKey       || null,
        publicKey:     publicKey       || null,
        hmacSecret:    hmacSecret      || null,
        integrationId: isNaN(integrationId) ? null : integrationId,
        baseUrl:       baseUrl.replace(/\/$/, ''), // strip trailing slash
    });
}

// Singleton — evaluated once when first imported.
const paymobConfig = loadPaymobConfig();

module.exports = paymobConfig;
