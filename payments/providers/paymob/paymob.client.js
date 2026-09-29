/**
 * payments/providers/paymob/paymob.client.js
 * Dedicated HTTP client for the Paymob Intention API.
 *
 * Responsibilities:
 *  - Construct authenticated requests (Authorization: Token <SECRET_KEY>)
 *  - Apply explicit HTTP timeouts
 *  - Handle and categorize Paymob HTTP errors
 *  - Validate that responses contain required fields
 *  - NEVER expose secrets in logs or error messages
 *
 * The client knows nothing about our business logic — that belongs in paymob.service.js.
 */

'use strict';

const axios = require('axios');
const paymobConfig = require('../../config/paymobConfig');
const { PAYMOB_ENDPOINTS, PAYMOB_HTTP_TIMEOUT_MS } = require('../../constants/paymentConstants');
const logger = require('../../../utils/logger');
const ApiError = require('../../../utils/ApiError');

/**
 * Build an Axios instance pre-configured for Paymob.
 * Returns a new instance each call to avoid shared state issues.
 */
function buildPaymobAxios() {
    if (!paymobConfig.secretKey) {
        throw new ApiError(503, 'خدمة الدفع عبر Paymob غير مهيأة بعد، يرجى ضبط المتغيرات في لوحة التحكم', 'PAYMENT_CONFIG_MISSING');
    }
    return axios.create({
        baseURL: paymobConfig.baseUrl,
        timeout: PAYMOB_HTTP_TIMEOUT_MS,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Token ${paymobConfig.secretKey}`,
        },
    });
}

/**
 * Map an Axios error from Paymob into a structured ApiError.
 * NEVER includes the secret key in the message.
 *
 * @param {Error} err - Axios error
 * @param {string} operation - human label for logging context
 * @param {string} requestId - correlation ID for structured logs
 */
function mapPaymobError(err, operation, requestId) {
    const status   = err.response?.status;
    const data     = err.response?.data;
    const code     = err.code; // ECONNABORTED, ETIMEDOUT, etc.

    // Log internal details (safe — no secrets in err.response.data usually)
    logger.error(`[PaymobClient] ${operation} failed`, {
        requestId,
        status,
        code,
        responseData: data,
        message: err.message,
    });

    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        return ApiError.serviceUnavailable(
            'خدمة الدفع غير متاحة حالياً، يرجى المحاولة بعد قليل',
            'PAYMENT_PROVIDER_ERROR'
        );
    }

    if (!err.response) {
        return ApiError.serviceUnavailable(
            'تعذر الاتصال ببوابة الدفع',
            'PAYMENT_PROVIDER_ERROR'
        );
    }

    // 4xx from Paymob = bad request on our side (config/integration issue)
    if (status >= 400 && status < 500) {
        return ApiError.internal(
            'حدث خطأ في إعداد عملية الدفع',
            'PAYMENT_PROVIDER_ERROR'
        );
    }

    // 5xx from Paymob = their fault
    return ApiError.serviceUnavailable(
        'بوابة الدفع غير متاحة مؤقتاً، يرجى المحاولة لاحقاً',
        'PAYMENT_PROVIDER_ERROR'
    );
}

// ─── Public Client Interface ──────────────────────────────────────────────────

/**
 * Create a Paymob Payment Intention.
 *
 * @param {object} intentionPayload - Full Paymob intention request body
 * @param {string} requestId - Correlation ID for logging
 * @returns {Promise<object>} Paymob intention response body
 * @throws {ApiError} on any network or provider failure
 */
async function createIntention(intentionPayload, requestId) {
    const http = buildPaymobAxios();
    try {
        const response = await http.post(PAYMOB_ENDPOINTS.INTENTION, intentionPayload);
        const data = response.data;

        // Validate response contains the fields we need
        if (!data?.client_secret || !data?.id) {
            logger.error('[PaymobClient] createIntention: unexpected response shape', {
                requestId,
                responseKeys: data ? Object.keys(data) : 'null',
            });
            throw ApiError.internal('بوابة الدفع أعادت استجابة غير متوقعة', 'PAYMENT_PROVIDER_ERROR');
        }

        logger.info('[PaymobClient] Intention created successfully', {
            requestId,
            intentionId: data.id,
            // NEVER log client_secret — it can be used to initiate checkout
        });

        return data;
    } catch (err) {
        if (err instanceof ApiError) throw err;
        throw mapPaymobError(err, 'createIntention', requestId);
    }
}

/**
 * Request a refund for a Paymob transaction.
 *
 * Paymob refund endpoint:
 *   POST /api/acceptance/void_refund/refund
 *   { transaction_id, amount_cents }
 *
 * @param {object} params
 * @param {string} params.transactionId - Paymob transaction ID to refund
 * @param {number} params.amountPiastres - Integer piastres to refund
 * @param {string} params.requestId - Correlation ID
 * @returns {Promise<object>} Paymob refund response
 */
async function refundTransaction({ transactionId, amountPiastres, requestId }) {
    const http = buildPaymobAxios();
    try {
        const response = await http.post(PAYMOB_ENDPOINTS.REFUND, {
            transaction_id: Number(transactionId),
            amount_cents:   Number(amountPiastres),
        });

        logger.info('[PaymobClient] Refund request accepted', {
            requestId,
            transactionId,
            amountPiastres,
        });

        return response.data;
    } catch (err) {
        if (err instanceof ApiError) throw err;
        throw mapPaymobError(err, 'refundTransaction', requestId);
    }
}

module.exports = {
    createIntention,
    refundTransaction,
};
