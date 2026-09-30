/**
 * payments/providers/paymob/paymob.service.js
 * Paymob-specific business logic layer.
 *
 * Orchestrates:
 *  - Building the intention payload with server-side authoritative amounts
 *  - Creating the Paymob intention via paymob.client
 *  - Processing transaction webhooks
 *  - Validating callback fields (amount, currency, integrationId)
 *
 * This service sits between PaymentService (domain layer) and the HTTP client.
 * It knows about Paymob-specific concepts but not about our routing/middleware.
 */

'use strict';

const paymobClient = require('./paymob.client');
const paymobMapper = require('./paymob.mapper');
const { verifyTransactionCallbackHmac } = require('./paymob.hmac');
const paymobConfig = require('../../config/paymobConfig');
const { PAYMENT_ERROR_CODES } = require('../../constants/paymentConstants');
const logger = require('../../../utils/logger');
const ApiError = require('../../../utils/ApiError');
const { buildUrl } = require('../../../config/urlBuilder');

/**
 * Create a Paymob Payment Intention.
 * Returns only the fields needed by PaymentService — not raw Paymob internals.
 *
 * @param {object} params
 * @param {number}  params.amountPiastres   - Authoritative integer piastres from server
 * @param {string}  params.specialReference - Our internal payment reference key
 * @param {object}  params.user             - User document for billing data
 * @param {string}  params.requestId
 * @returns {Promise<{ clientSecret, providerIntentionId, providerOrderId, expiresAt }>}
 */
async function createPaymobIntention({
    amountPiastres,
    specialReference,
    user,
    paymentMethod = 'ALL',
    walletPhoneNumber,
    requestId,
}) {
    const billingData     = paymobMapper.buildBillingData(user);
    const notificationUrl = buildWebhookUrl();
    const redirectionUrl  = buildRedirectionUrl();

    // Sanitize critical fields for Paymob API
    // Paymob rejects 'NA' for phone_number and requires a valid phone format.
    const rawPhone = walletPhoneNumber || billingData.phone_number;
    if (!rawPhone || rawPhone === 'NA') {
        billingData.phone_number = '+201000000000';
    } else {
        let phone = String(rawPhone).replace(/[\s\-()]/g, '');
        if (phone.startsWith('01')) {
            phone = '+2' + phone;
        } else if (!phone.startsWith('+')) {
            phone = '+' + phone;
        }
        billingData.phone_number = phone;
    }
    if (!billingData.first_name || billingData.first_name === 'NA') {
        billingData.first_name = (user?.name && user.name.split(' ')[0]) || 'عميل';
    }
    if (!billingData.last_name || billingData.last_name === 'NA') {
        billingData.last_name = (user?.name && user.name.split(' ').slice(1).join(' ')) || 'مشاوير';
    }
    if (!billingData.email || billingData.email === 'NA' || !billingData.email.includes('@')) {
        billingData.email = `${user?._id || 'customer'}@mashawerr.com`;
    }

    const payload = paymobMapper.buildIntentionPayload({
        amountPiastres,
        specialReference,
        billingData,
        notificationUrl,
        redirectionUrl,
        paymentMethod,
        extras: {
            payment_reference: specialReference,
        },
    });

    logger.info('[PaymobService] Creating intention', {
        requestId,
        specialReference,
        amountPiastres,
        paymentMethod,
        // Never log the full payload as it contains integration ID
    });

    const raw = await paymobClient.createIntention(payload, requestId);
    const mapped = paymobMapper.mapIntentionResponse(raw);

    const { PAYMENT_EXPIRY_MINUTES } = require('../../constants/paymentConstants');
    const expiresAt = new Date(Date.now() + PAYMENT_EXPIRY_MINUTES * 60 * 1000);

    const checkoutUrl = paymobConfig.publicKey
        ? `https://accept.paymob.com/unifiedcheckout/?publicKey=${encodeURIComponent(paymobConfig.publicKey)}&clientSecret=${encodeURIComponent(mapped.clientSecret)}`
        : `https://accept.paymob.com/unifiedcheckout/?clientSecret=${encodeURIComponent(mapped.clientSecret)}`;

    return {
        clientSecret:        mapped.clientSecret,
        providerIntentionId: mapped.providerIntentionId,
        providerOrderId:     mapped.providerOrderId,
        expiresAt,
        checkoutUrl,
        publicKey:           paymobConfig.publicKey,
    };
}

/**
 * Validate a Paymob transaction callback payload AFTER HMAC has passed.
 *
 * Validates:
 *  - callback has a transaction object
 *  - integration_id matches our config (prevent cross-merchant attacks)
 *  - amount_cents matches our stored payment amount
 *  - currency matches our stored currency
 *  - success / pending / voided flags
 *
 * @param {object} params
 * @param {object} params.transaction    - Paymob transaction object from webhook body
 * @param {object} params.storedPayment  - Our Payment document from DB
 * @param {string} params.requestId
 * @returns {{ isSuccess: boolean, isFailed: boolean, isVoided: boolean, isPending: boolean }}
 * @throws {ApiError} if any critical validation fails
 */
function validateTransactionCallback({ transaction, storedPayment, requestId }) {
    // 1. Integration ID check — ensure transaction was processed through OUR integrations (cards or wallets)
    const callbackIntegrationId = Number(transaction.integration_id);
    const validIntegrationIds = Array.isArray(paymobConfig.integrationIds) && paymobConfig.integrationIds.length > 0
        ? paymobConfig.integrationIds
        : (paymobConfig.integrationId ? [paymobConfig.integrationId] : []);

    if (validIntegrationIds.length > 0 && !validIntegrationIds.includes(callbackIntegrationId)) {
        logger.warn('[PaymobService] Integration ID mismatch', {
            requestId,
            expected: validIntegrationIds,
            received: callbackIntegrationId,
            transactionId: transaction.id,
        });
        throw new ApiError(
            400,
            'Payment integration mismatch',
            PAYMENT_ERROR_CODES.PAYMENT_INTEGRATION_MISMATCH,
            null,
            true
        );
    }

    // 2. Amount check — CRITICAL security requirement
    const callbackAmount = Number(transaction.amount_cents);
    if (callbackAmount !== storedPayment.amountPiastres) {
        logger.warn('[PaymobService] Amount mismatch detected', {
            requestId,
            stored:  storedPayment.amountPiastres,
            received: callbackAmount,
            transactionId: transaction.id,
            paymentId: storedPayment._id,
        });
        throw new ApiError(
            400,
            'Payment amount mismatch',
            PAYMENT_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH,
            null,
            true
        );
    }

    // 3. Currency check
    const callbackCurrency = (transaction.currency || '').trim().toUpperCase();
    const expectedCurrency = storedPayment.currency.trim().toUpperCase();
    if (callbackCurrency !== expectedCurrency) {
        logger.warn('[PaymobService] Currency mismatch detected', {
            requestId,
            expected: expectedCurrency,
            received: callbackCurrency,
            transactionId: transaction.id,
        });
        throw new ApiError(
            400,
            'Payment currency mismatch',
            PAYMENT_ERROR_CODES.PAYMENT_CURRENCY_MISMATCH,
            null,
            true
        );
    }

    const isSuccess = transaction.success === true;
    const isPending = transaction.pending === true;
    const isVoided  = transaction.is_voided === true;
    const isFailed  = !isSuccess && !isPending;

    return { isSuccess, isFailed, isVoided, isPending };
}

/**
 * Verify HMAC for a transaction callback, throwing ApiError on failure.
 * Wrapper around the pure HMAC verifier to integrate with the service layer.
 *
 * @param {object} transaction - Paymob transaction object
 * @param {string} receivedHmac - from req.query.hmac
 * @param {string} requestId
 */
function assertValidHmac(transaction, receivedHmac, requestId) {
    const valid = verifyTransactionCallbackHmac(transaction, receivedHmac, requestId);
    if (!valid) {
        logger.warn('[PaymobService] HMAC verification failed', {
            requestId,
            transactionId: transaction?.id,
        });
        throw new ApiError(
            400,
            'Invalid payment signature',
            PAYMENT_ERROR_CODES.PAYMENT_HMAC_INVALID,
            null,
            true
        );
    }
}

/**
 * Request a refund via the Paymob client.
 *
 * @param {object} params
 * @param {string} params.providerTransactionId
 * @param {number} params.amountPiastres
 * @param {string} params.requestId
 */
async function requestRefund({ providerTransactionId, amountPiastres, requestId }) {
    return paymobClient.refundTransaction({
        transactionId: providerTransactionId,
        amountPiastres,
        requestId,
    });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Construct the webhook URL Paymob will POST to.
 * Uses RENDER_EXTERNAL_URL or HOST from env, falling back to localhost in dev.
 */
function buildWebhookUrl() {
    const base =
        process.env.RENDER_EXTERNAL_URL ||
        process.env.HOST ||
        `http://localhost:${process.env.PORT || 3000}`;
    return `${base.replace(/\/$/, '')}/api/payments/paymob/webhook`;
}

function buildRedirectionUrl() {
    const base =
        process.env.RENDER_EXTERNAL_URL ||
        process.env.HOST ||
        `http://localhost:${process.env.PORT || 3000}`;
    return `${base.replace(/\/$/, '')}/api/payments/paymob/redirect`;
}

module.exports = {
    createPaymobIntention,
    validateTransactionCallback,
    assertValidHmac,
    requestRefund,
};
