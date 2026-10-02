/**
 * payments/providers/paymob/paymob.hmac.js
 * Paymob HMAC verification for transaction callbacks.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IMPORTANT — Paymob Transaction Callback HMAC (Accept v2 / current API)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Paymob sends a TRANSACTION callback to our webhook URL.
 * The HMAC is sent as a query parameter: ?hmac=<value>
 *
 * The HMAC is computed by Paymob as:
 *   1. Extract the following fields from the transaction object (in THIS exact order):
 *
 *        amount_cents
 *        created_at
 *        currency
 *        error_occured          ← Paymob uses this typo ("occured" not "occurred")
 *        has_parent_transaction
 *        id                     ← transaction ID (integer)
 *        integration_id
 *        is_3d_secure
 *        is_auth
 *        is_capture
 *        is_indexed
 *        is_standalone_payment
 *        is_voided
 *        order.id               ← Paymob order ID (nested)
 *        owner
 *        pending
 *        source_data.pan        ← nested
 *        source_data.sub_type   ← nested
 *        source_data.type       ← nested
 *        success
 *
 *   2. Concatenate all values (as strings) in the above order WITHOUT any separator.
 *   3. Compute HMAC-SHA512 of the concatenated string using PAYMOB_HMAC_SECRET.
 *   4. Compare (timing-safe) against the hmac query param.
 *
 * Source: Official Paymob Accept docs and multiple verified community integrations.
 * Reference: https://developers.paymob.com/egypt/accept-transaction-callback
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * For CARD TOKEN callbacks the field list is DIFFERENT — see verifyTokenCallbackHmac.
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

const crypto = require('crypto');
const paymobConfig = require('../../config/paymobConfig');
const logger = require('../../../utils/logger');

/**
 * Fields used for TRANSACTION callback HMAC, in the exact required order.
 * Paymob concatenates VALUES of these fields (no keys, no separators).
 */
const TRANSACTION_HMAC_FIELDS = Object.freeze([
    'amount_cents',
    'created_at',
    'currency',
    'error_occured',           // intentional Paymob typo
    'has_parent_transaction',
    'id',
    'integration_id',
    'is_3d_secure',
    'is_auth',
    'is_capture',
    'is_indexed',
    'is_standalone_payment',
    'is_voided',
    'order.id',                // nested: transaction.order.id
    'owner',
    'pending',
    'source_data.pan',         // nested: transaction.source_data.pan
    'source_data.sub_type',    // nested: transaction.source_data.sub_type
    'source_data.type',        // nested: transaction.source_data.type
    'success',
]);

/**
 * Safely retrieve a nested or top-level value from an object.
 * Supports dot-notation: 'order.id', 'source_data.pan'
 *
 * @param {object} obj
 * @param {string} path - dot-separated key path
 * @returns {string} Value converted to string. Unknown/null/undefined → empty string.
 */
function getNestedValue(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current == null) return '';
        current = current[part];
    }
    if (current == null) return '';
    return String(current);
}

/**
 * Build the concatenated string from a parsed Paymob transaction object
 * that will be HMAC-hashed.
 *
 * @param {object} transaction - Parsed Paymob transaction object from webhook body
 * @returns {string} Concatenated field values
 */
function buildTransactionHmacString(transaction) {
    return TRANSACTION_HMAC_FIELDS.map((field) => getNestedValue(transaction, field)).join('');
}

/**
 * Compute the expected HMAC-SHA512 for a Paymob transaction callback.
 *
 * @param {object} transaction - Paymob transaction object
 * @returns {string} Hex-encoded HMAC-SHA512
 */
function computeTransactionHmac(transaction) {
    const hmacSecret = paymobConfig.hmacSecret;
    if (!hmacSecret) {
        throw new Error('[PaymobHmac] PAYMOB_HMAC_SECRET is not configured');
    }
    const concatenated = buildTransactionHmacString(transaction);
    return crypto
        .createHmac('sha512', hmacSecret)
        .update(concatenated)
        .digest('hex');
}

/**
 * Verify the HMAC of a Paymob TRANSACTION callback.
 *
 * Uses timing-safe comparison to prevent timing-based attacks.
 *
 * @param {object} transaction - Parsed Paymob transaction from webhook body
 * @param {string} receivedHmac - HMAC value from the ?hmac= query parameter
 * @param {string} requestId - Correlation ID for logging
 * @returns {boolean} true if valid, false if tampered/invalid
 */
function verifyTransactionCallbackHmac(transaction, receivedHmac, requestId) {
    try {
        if (!receivedHmac || typeof receivedHmac !== 'string') {
            logger.warn('[PaymobHmac] Missing or invalid hmac query parameter', { requestId });
            return false;
        }

        const expected = computeTransactionHmac(transaction);
        const expectedBuf = Buffer.from(expected, 'hex');
        const receivedBuf = Buffer.from(receivedHmac, 'hex');

        // Lengths must match before timingSafeEqual (otherwise it throws)
        if (expectedBuf.length !== receivedBuf.length) {
            logger.warn('[PaymobHmac] HMAC length mismatch', {
                requestId,
                expectedLen: expectedBuf.length,
                receivedLen: receivedBuf.length,
            });
            return false;
        }

        const isValid = crypto.timingSafeEqual(expectedBuf, receivedBuf);

        if (!isValid) {
            logger.warn('[PaymobHmac] HMAC verification FAILED — possible tampering', {
                requestId,
                // DO NOT log the HMAC secret, the received value, or expected value here
                transactionId: transaction?.id,
            });
        }

        return isValid;
    } catch (err) {
        logger.error('[PaymobHmac] Exception during HMAC verification', {
            requestId,
            message: err.message,
        });
        return false;
    }
}

/**
 * Verify HMAC for a Paymob CARD TOKEN callback.
 *
 * ⚠️  Card token callbacks use a DIFFERENT field list than transaction callbacks.
 * Fields (verified order):
 *   card_subtype, created_at, email, id, masked_pan, merchant_id, order_id, token
 *
 * @param {object} tokenData - Parsed token callback data
 * @param {string} receivedHmac - HMAC from ?hmac= query param
 * @param {string} requestId
 * @returns {boolean}
 */
function verifyTokenCallbackHmac(tokenData, receivedHmac, requestId) {
    try {
        if (!receivedHmac || typeof receivedHmac !== 'string') return false;

        const TOKEN_FIELDS = [
            'card_subtype',
            'created_at',
            'email',
            'id',
            'masked_pan',
            'merchant_id',
            'order_id',
            'token',
        ];

        const hmacSecret = paymobConfig.hmacSecret;
        if (!hmacSecret) throw new Error('[PaymobHmac] PAYMOB_HMAC_SECRET not configured');

        const concatenated = TOKEN_FIELDS.map((f) => getNestedValue(tokenData, f)).join('');
        const expected = crypto.createHmac('sha512', hmacSecret).update(concatenated).digest('hex');

        const expectedBuf = Buffer.from(expected, 'hex');
        const receivedBuf = Buffer.from(receivedHmac, 'hex');

        if (expectedBuf.length !== receivedBuf.length) return false;
        return crypto.timingSafeEqual(expectedBuf, receivedBuf);
    } catch (err) {
        logger.error('[PaymobHmac] Token HMAC exception', { requestId, message: err.message });
        return false;
    }
}

/**
 * Fields used for TRANSACTION RESPONSE (Redirect) callback HMAC, in the exact required order.
 * Reference: Paymob Accept Transaction Response Callback.
 */
const TRANSACTION_RESPONSE_HMAC_FIELDS = Object.freeze([
    'amount_cents',
    'created_at',
    'currency',
    'error_occured',
    'has_parent_transaction',
    'id',
    'integration_id',
    'is_3d_secure',
    'is_auth',
    'is_capture',
    'is_refunded',
    'is_standalone_payment',
    'is_voided',
    'order',
    'owner',
    'pending',
    'source_data.pan',
    'source_data.sub_type',
    'source_data.type',
    'success',
]);

/**
 * Verify HMAC for a Paymob TRANSACTION RESPONSE callback (Redirect URL query params).
 *
 * @param {object} queryParams - Query parameters from redirect request
 * @param {string} receivedHmac - HMAC hex string from req.query.hmac
 * @param {string} requestId - Correlation ID
 * @returns {boolean} true if valid, false if invalid or tampered
 */
function verifyTransactionResponseHmac(queryParams, receivedHmac, requestId) {
    try {
        if (!receivedHmac || typeof receivedHmac !== 'string') {
            return false;
        }

        const hmacSecret = paymobConfig.hmacSecret;
        if (!hmacSecret) {
            throw new Error('[PaymobHmac] PAYMOB_HMAC_SECRET not configured');
        }

        const concatenated = TRANSACTION_RESPONSE_HMAC_FIELDS.map((field) => {
            const val = queryParams[field];
            return val != null ? String(val) : '';
        }).join('');

        const expected = crypto
            .createHmac('sha512', hmacSecret)
            .update(concatenated)
            .digest('hex');

        const expectedBuf = Buffer.from(expected, 'hex');
        const receivedBuf = Buffer.from(receivedHmac, 'hex');

        if (expectedBuf.length !== receivedBuf.length) {
            logger.warn('[PaymobHmac] Response HMAC length mismatch', {
                requestId,
                expectedLen: expectedBuf.length,
                receivedLen: receivedBuf.length,
            });
            return false;
        }

        const isValid = crypto.timingSafeEqual(expectedBuf, receivedBuf);
        if (!isValid) {
            logger.warn('[PaymobHmac] Response HMAC verification FAILED — possible tampering', {
                requestId,
                transactionId: queryParams?.id,
            });
        }

        return isValid;
    } catch (err) {
        logger.error('[PaymobHmac] Exception during response HMAC verification', {
            requestId,
            message: err.message,
        });
        return false;
    }
}

module.exports = {
    verifyTransactionCallbackHmac,
    verifyTokenCallbackHmac,
    verifyTransactionResponseHmac,
    buildTransactionHmacString, // exported for unit testing only
    computeTransactionHmac,     // exported for unit testing only
    TRANSACTION_HMAC_FIELDS,
    TRANSACTION_RESPONSE_HMAC_FIELDS,
};

