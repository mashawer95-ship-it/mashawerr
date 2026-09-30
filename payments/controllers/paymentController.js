/**
 * payments/controllers/paymentController.js
 * HTTP controllers for the payment endpoints.
 *
 * Follows the exact same pattern as the existing orderController.js:
 *  - asyncHandler for async error forwarding
 *  - Joi validation
 *  - ApiError for operational errors
 *  - Structured logger calls
 *  - req.id for correlation
 *  - req.user for auth identity (never req.body.userId)
 */

'use strict';

const asyncHandler = require('express-async-handler');
const paymentService = require('../services/paymentService');
const paymobService  = require('../providers/paymob/paymob.service');
const {
    validateCreatePaymentParams,
    validateWebhookQuery,
    validateTransactionCallback,
    validateRefundRequest,
} = require('../validators/paymentValidators');
const { PAYMOB_CALLBACK_TYPES, PAYMENT_ERROR_CODES } = require('../constants/paymentConstants');
const ApiError = require('../../utils/ApiError');
const logger   = require('../../utils/logger');

// ─── POST /api/orders/:orderId/payment ───────────────────────────────────────

/**
 * Create a payment intention for an order.
 *
 * Authentication: required (authenticate middleware on route)
 * Authorization:  user must own the order (enforced in paymentService)
 *
 * Request:
 *   POST /api/orders/:orderId/payment
 *   Headers: Authorization: Bearer <token>
 *   Body: {} (empty — amount is computed server-side)
 *
 * Response 200:
 *   {
 *     "success": true,
 *     "data": {
 *       "paymentId": "...",
 *       "status": "PENDING",
 *       "clientSecret": "...",
 *       "expiresAt": "2024-..."
 *     }
 *   }
 */
const createPayment = asyncHandler(async (req, res) => {
    const requestId = req.id;

    // Validate route param
    const { error: paramsError } = validateCreatePaymentParams(req.params);
    if (paramsError) {
        throw ApiError.badRequest(
            paramsError.details.map((d) => d.message).join('; '),
            'VALIDATION_ERROR'
        );
    }

    const { orderId } = req.params;
    // userId ALWAYS from JWT — NEVER from req.body
    const userId = req.user?.id || req.user?._id;

    logger.info('[PaymentController] createPayment request', {
        requestId,
        orderId,
        userId,
    });

    const result = await paymentService.createPayment({ orderId, userId, requestId });

    return res.status(200).json({
        success: true,
        data: {
            paymentId:    result.paymentId,
            status:       result.status,
            clientSecret: result.clientSecret,
            checkoutUrl:  result.checkoutUrl,
            publicKey:    result.publicKey,
            expiresAt:    result.expiresAt,
        },
    });
});

// ─── POST /api/payments/paymob/webhook ───────────────────────────────────────

/**
 * Paymob transaction callback (webhook).
 *
 * Authentication: NONE — this is an unauthenticated Paymob callback.
 *   Security is via HMAC verification inside the handler.
 *
 * CRITICAL:
 *   - HMAC is verified BEFORE any business logic.
 *   - Returns 200 for successfully processed callbacks.
 *   - Returns 400 for invalid HMAC or validation failures.
 *   - Returns 200 for duplicate/already-processed callbacks (safe ACK).
 *
 * Paymob sends:
 *   POST /api/payments/paymob/webhook?hmac=<hash>&type=TRANSACTION
 *   Body: { "obj": { ...transaction... }, "type": "TRANSACTION" }
 *
 * NOTE on raw body:
 *   Paymob's HMAC for TRANSACTION callbacks is computed from individual
 *   FIELD VALUES (not the raw body), so standard JSON parsing is safe here.
 *   We do NOT need express.raw() for this endpoint.
 */
const paymobWebhook = asyncHandler(async (req, res) => {
    const requestId = req.id;

    logger.info('[PaymentController] PAYMENT_WEBHOOK_RECEIVED', {
        requestId,
        query: { type: req.query.type },
        // Never log hmac value or body
    });

    // 1. Validate query parameters
    const { error: queryError, value: queryValue } = validateWebhookQuery(req.query);
    if (queryError) {
        logger.warn('[PaymentController] Webhook query validation failed', {
            requestId,
            details: queryError.details.map((d) => d.message),
        });
        return res.status(400).json({ success: false, message: 'Invalid webhook query parameters' });
    }

    const receivedHmac   = queryValue.hmac;
    const callbackType   = queryValue.type || 'TRANSACTION';

    // 2. Handle TRANSACTION callbacks
    if (callbackType === PAYMOB_CALLBACK_TYPES.TRANSACTION) {
        return _handleTransactionCallback({ req, res, receivedHmac, requestId });
    }

    // 3. Unsupported callback types — acknowledge safely
    logger.info('[PaymentController] Unhandled webhook type acknowledged', {
        requestId,
        callbackType,
    });
    return res.status(200).json({ success: true, message: 'Acknowledged' });
});

// ─── GET /api/payments/paymob/redirect ───────────────────────────────────────

/**
 * Paymob redirect endpoint — called when customer completes checkout on Paymob's page.
 *
 * SECURITY: This endpoint MUST NOT confirm payment status.
 * It only provides a user-facing acknowledgement.
 * The webhook is the authoritative payment confirmation.
 *
 * The mobile app should:
 *   1. Deep link back to the app from this page, OR
 *   2. Poll GET /api/orders/:orderId/payment-status to check current state.
 */
const paymobRedirect = asyncHandler(async (req, res) => {
    const requestId = req.id;
    // ── SECURITY: This endpoint is UX-only navigation.
    // It MUST NOT confirm payment status, trigger financial operations,
    // mark payments as paid, or call processWebhookTransaction.
    // The ONLY authoritative confirmation source is the server-to-server
    // Paymob webhook at POST /api/payments/paymob/webhook (which verifies
    // the HMAC signature before any business logic).
    //
    // This page exists solely to give the user a human-readable result page
    // in the browser after returning from Paymob's hosted checkout.
    // The mobile app polls GET /api/orders/:orderId/payment-status for the
    // authoritative payment state.
    logger.info('[PaymentController] Paymob redirect received (UX-only, no financial action)', {
        requestId,
        // Only log non-sensitive query keys for diagnostics (never log hmac/tokens)
        success: req.query.success,
        pending: req.query.pending,
    });

    // Derive the display state from the query param — this is DISPLAY ONLY,
    // never used to alter payment, order, wallet, or ledger state.
    const success = req.query.success === 'true';
    const isPending = req.query.pending === 'true';

    // Determine display state — purely cosmetic, NEVER financial
    const displayColor = success ? '#22c55e' : isPending ? '#f59e0b' : '#ef4444';
    const displayIcon  = success ? '✅' : isPending ? '⏳' : '❌';
    const displayTitle = success ? 'تم الدفع بنجاح' : isPending ? 'جارٍ المعالجة...' : 'لم يتم الدفع';
    const displayMsg   = success
        ? 'تمت عملية الدفع بنجاح، يمكنك العودة للتطبيق الآن لمتابعة طلبك.'
        : isPending
        ? 'عملية الدفع قيد المعالجة. سيتم تحديث حالة الطلب تلقائياً في التطبيق.'
        : 'حدث خطأ في الدفع، يرجى المحاولة مرة أخرى من التطبيق.';

    res.status(200).send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head><meta charset="UTF-8"><title>Mashawerr - الدفع</title>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5}
        .box{background:#fff;border-radius:12px;padding:32px;max-width:400px;margin:auto;box-shadow:0 2px 16px rgba(0,0,0,.1)}
        h2{color:${displayColor}}p{color:#666}</style></head>
        <body><div class="box">
        <h2>${displayIcon} ${displayTitle}</h2>
        <p>${displayMsg}</p>
        <p style="font-size:12px;color:#999;margin-top:24px">سيتم تحديث حالة العملية فوراً في التطبيق.</p>
        </div></body></html>
    `);
});

// ─── GET /api/orders/:orderId/payment-status ─────────────────────────────────

/**
 * Get current payment status for an order.
 * Mobile polls this after the redirect to show correct UI.
 *
 * Authentication: required
 */
const getPaymentStatus = asyncHandler(async (req, res) => {
    const requestId = req.id;
    const { orderId } = req.params;
    const userId = req.user?.id || req.user?._id;

    const { error } = validateCreatePaymentParams(req.params);
    if (error) {
        throw ApiError.badRequest(error.details.map((d) => d.message).join('; '), 'VALIDATION_ERROR');
    }

    const { Payment } = require('../../middlewares/Payment');
    const { Order }   = require('../../middlewares/Order');

    const order = await Order.findById(orderId).lean();
    if (!order) throw ApiError.notFound('الطلب غير موجود', PAYMENT_ERROR_CODES.ORDER_NOT_FOUND);

    // Auth check
    const orderOwner = (order.clientId || order.userId || '').toString();
    if (orderOwner !== userId.toString() && !req.user?.isAdmin) {
        throw ApiError.forbidden('غير مسموح بالوصول', PAYMENT_ERROR_CODES.PAYMENT_UNAUTHORIZED);
    }

    const payment = await Payment.findOne({ orderId: order._id })
        .sort({ createdAt: -1 })
        .select('status amountPiastres currency paidAt failedAt failureReason expiresAt createdAt')
        .lean();

    return res.status(200).json({
        success: true,
        data: payment
            ? {
                paymentStatus:  payment.status,
                amountEgp:      (payment.amountPiastres / 100).toFixed(2),
                currency:       payment.currency,
                paidAt:         payment.paidAt,
                failedAt:       payment.failedAt,
                failureReason:  payment.failureReason,
                expiresAt:      payment.expiresAt,
              }
            : { paymentStatus: 'NONE' },
    });
});

// ─── POST /api/payments/:paymentId/refund ────────────────────────────────────

/**
 * Admin-only: request a refund for a payment.
 *
 * Authentication: required
 * Authorization:  admin or administration role only
 */
const refundPayment = asyncHandler(async (req, res) => {
    const requestId = req.id;
    const { paymentId } = req.params;
    const userId = req.user?.id || req.user?._id;

    const { error: bodyError, value: body } = validateRefundRequest(req.body);
    if (bodyError) {
        throw ApiError.badRequest(bodyError.details.map((d) => d.message).join('; '), 'VALIDATION_ERROR');
    }

    logger.info('[PaymentController] Refund requested', {
        requestId,
        paymentId,
        requestedBy: userId,
        amount: body.amount,
    });

    const result = await paymentService.refundPayment({
        paymentId,
        amountPiastres: body.amount || null,
        requestedBy:    userId,
        requestId,
    });

    return res.status(200).json({
        success: true,
        data: {
            paymentId:              result._id,
            status:                 result.status,
            amountPiastres:         result.amountPiastres,
            refundedAmountPiastres: result.refundedAmountPiastres,
            refundedAt:             result.refundedAt,
        },
    });
});

// ─── Private: transaction callback handler ────────────────────────────────────

async function _handleTransactionCallback({ req, res, receivedHmac, requestId }) {
    // 1. Validate body structure
    const { error: bodyError } = validateTransactionCallback(req.body);
    if (bodyError) {
        logger.warn('[PaymentController] Transaction callback body invalid', {
            requestId,
            details: bodyError.details.map((d) => d.message),
        });
        return res.status(400).json({ success: false, message: 'Invalid callback body' });
    }

    const transaction = req.body.obj;

    // 2. HMAC verification — MUST happen before any business logic
    try {
        paymobService.assertValidHmac(transaction, receivedHmac, requestId);
    } catch (err) {
        // Return 400 — invalid HMAC means we cannot trust this callback.
        // Do NOT return 200 — we don't want Paymob to stop retrying if the HMAC is actually correct.
        return res.status(400).json({ success: false, message: 'Invalid HMAC signature' });
    }

    // 3. Process the transaction
    try {
        await paymentService.processWebhookTransaction({ transaction, requestId });
    } catch (err) {
        if (err.code === PAYMENT_ERROR_CODES.PAYMENT_AMOUNT_MISMATCH
            || err.code === PAYMENT_ERROR_CODES.PAYMENT_CURRENCY_MISMATCH
            || err.code === PAYMENT_ERROR_CODES.PAYMENT_INTEGRATION_MISMATCH) {
            logger.warn('[PaymentController] Webhook validation failed post-HMAC', {
                requestId,
                code: err.code,
                transactionId: transaction.id,
            });
            // Return 400 — Paymob should not retry for data validation failures
            return res.status(400).json({ success: false, message: err.message, code: err.code });
        }
        // For internal errors, return 500 so Paymob retries
        logger.error('[PaymentController] Webhook processing error', {
            requestId,
            message: err.message,
            stack: err.stack,
        });
        return res.status(500).json({ success: false, message: 'Internal processing error' });
    }

    // 4. Always acknowledge with 200 after successful processing
    return res.status(200).json({ success: true, message: 'Processed' });
}

module.exports = {
    createPayment,
    paymobWebhook,
    paymobRedirect,
    getPaymentStatus,
    refundPayment,
};
