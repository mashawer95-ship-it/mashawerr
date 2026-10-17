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

    // 1. Validate query parameters (allow HMAC from query, headers, or body for resilience)
    const effectiveHmac = req.query.hmac
        || req.headers['hmac']
        || req.headers['x-paymob-hmac']
        || req.body?.hmac
        || req.body?.obj?.hmac;

    const candidateQuery = {
        ...req.query,
        hmac: effectiveHmac,
    };

    const { error: queryError, value: queryValue } = validateWebhookQuery(candidateQuery);
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
 * SECURE DUAL-CONFIRMATION:
 * Paymob appends all transaction fields and a cryptographically signed HMAC (?hmac=...)
 * to the redirection URL (Transaction Response Callback).
 *
 * If HMAC is verified with our PAYMOB_HMAC_SECRET:
 *  - We process the payment immediately (0-delay balance credit / order finalization).
 *  - Idempotency guarantees zero double-crediting if the webhook also arrives.
 *
 * If HMAC is missing or invalid:
 *  - NO financial operation is executed (UX display only).
 *  - Protects against malicious query param crafting.
 */
const paymobRedirect = asyncHandler(async (req, res) => {
    const requestId = req.id;
    const receivedHmac = req.query?.hmac;

    logger.info('[PaymentController] Paymob redirect received', {
        requestId,
        hasHmac: !!receivedHmac,
        id: req.query?.id,
        success: req.query?.success,
        pending: req.query?.pending,
    });

    const success = req.query?.success === 'true';
    const isPending = req.query?.pending === 'true';

    // ── SECURE TRANSACTION CONFIRMATION VIA REDIRECT HMAC ──────────────────────
    // Cryptographically verified via Paymob HMAC SHA-512 signature before any mutation.
    if (receivedHmac && paymobService.verifyTransactionResponseHmac(req.query, receivedHmac, requestId)) {
        if (success && req.query.id && req.query.amount_cents) {
            const transaction = {
                id: req.query.id,
                amount_cents: Number(req.query.amount_cents),
                currency: (req.query.currency || 'EGP').trim().toUpperCase(),
                success: true,
                pending: false,
                is_voided: req.query.is_voided === 'true' || req.query.is_void === 'true',
                integration_id: Number(req.query.integration_id),
                order: {
                    id: req.query.order,
                    merchant_order_id: req.query.merchant_order_id,
                },
                special_reference: req.query.merchant_order_id,
                source_data: {
                    type: req.query['source_data.type'] || req.query.source_data?.type || '',
                    sub_type: req.query['source_data.sub_type'] || req.query.source_data?.sub_type || '',
                    pan: req.query['source_data.pan'] || req.query.source_data?.pan || '',
                },
            };

            try {
                await paymentService.processWebhookTransaction({ transaction, requestId });
                logger.info('[PaymentController] Payment successfully confirmed and processed via verified redirect HMAC', {
                    requestId,
                    transactionId: transaction.id,
                    specialRef: transaction.special_reference,
                });
            } catch (err) {
                logger.error('[PaymentController] Error processing verified redirect payment', {
                    requestId,
                    err: err.message,
                });
            }
        }
    } else if (receivedHmac) {
        logger.warn('[PaymentController] Paymob redirect HMAC signature invalid — skipping automatic confirmation', {
            requestId,
            id: req.query?.id,
        });
    }

    // Determine display state — purely cosmetic for the browser / WebView
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
        amountPiastres:   body.amount || null,
        requestedBy:      userId,
        requestId,
        refundPreference: body.refundPreference || null,
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

// ─── Helpers: Arabic Translation for Payment & Refund Audit ──────────────────

function _translateOrderStatus(status) {
    const s = String(status || '').toLowerCase();
    switch (s) {
        case 'pending': return 'قيد الانتظار';
        case 'accepted': return 'تم قبول الطلب';
        case 'delivering': return 'جاري التوصيل';
        case 'confirmed': return 'تم التأكيد';
        case 'processing': return 'قيد التجهيز';
        case 'completed':
        case 'delivered': return 'تم التسليم بنجاح';
        case 'cancelled': return 'ملغي';
        case 'deleted': return 'محذوف';
        default: return status || 'غير محدد';
    }
}

function _translatePaymentStatus(status) {
    const s = String(status || '').toUpperCase();
    switch (s) {
        case 'PAID': return 'مدفوع بنجاح';
        case 'REFUNDED': return 'مسترد بالكامل (Refunded)';
        case 'PARTIALLY_REFUNDED': return 'مسترد جزئياً';
        case 'REFUND_PENDING': return 'الاسترداد قيد المعالجة البنكية (24-72 ساعة)';
        case 'PENDING': return 'بانتظار الدفع';
        case 'FAILED': return 'فشل الدفع';
        case 'CANCELLED': return 'ملغي';
        default: return status || 'غير محدد';
    }
}

function _translateRefundMethod(method, isVoided) {
    if (isVoided) return 'إلغاء حجز فوري بالبطاقة (VOID - فك الحجز اللحظي)';
    const m = String(method || '').toUpperCase();
    switch (m) {
        case 'CARD_GATEWAY':
        case 'ORIGINAL_PAYMENT':
        case 'CARD': return 'استرداد للبطاقة البنكية الأصلية عبر Paymob';
        case 'APP_WALLET':
        case 'WALLET':
        case 'WALLET_FALLBACK': return 'استرداد لمحفظة التطبيق (App Wallet)';
        default: return method ? String(method) : 'غير محدد';
    }
}

function _translateEventType(type) {
    const t = String(type || '').toUpperCase();
    switch (t) {
        case 'PAYMENT_CHECKOUT_STARTED': return 'بدء عملية الدفع';
        case 'PAYMENT_INTENTION_CREATED': return 'إنشاء نية الدفع لدى Paymob';
        case 'PAYMENT_WEBHOOK_RECEIVED': return 'استلام إشعار الدفع من Paymob';
        case 'ORDER_CREATED_AFTER_PAYMENT': return 'تأكيد إنشاء الطلب بعد الدفع';
        case 'PAYMENT_REFUND_REQUESTED': return 'بدء طلب الاسترداد المالي';
        case 'PAYMENT_REFUND_SUCCEEDED': return 'اكتمال الاسترداد المالي بنجاح';
        case 'WALLET_TOPUP_CREATED': return 'إنشاء طلب شحن محفظة';
        case 'WALLET_TOPUP_COMPLETED': return 'اكتمال شحن المحفظة';
        case 'WALLET_CREDIT': return 'إيداع رصيد بالمحفظة';
        case 'WALLET_DEBIT': return 'خصم رصيد من المحفظة';
        default: return type ? String(type) : 'حدث دفع';
    }
}

// ─── GET /api/payments/admin/audit ───────────────────────────────────────────

/**
 * Diagnostic Payment & Refund Audit for Admins.
 * Accepts:
 *   - Order numeric ID (e.g., 117)
 *   - Order Mongo ObjectId
 *   - Paymob Transaction ID (e.g., 551586508)
 *   - Paymob Order ID (e.g., 629453479)
 *
 * Returns authoritative payment, refund, wallet, and events audit details.
 */
const auditPaymentByOrder = asyncHandler(async (req, res) => {
    const rawQuery = String(req.query.query || req.query.orderId || req.query.transactionId || '').trim();
    if (!rawQuery) {
        return res.status(400).json({
            success: false,
            message: 'برجاء إدخال رقم الطلب أو رقم المعاملة للبحث',
        });
    }

    const mongoose = require('mongoose');
    const { Payment, PaymentEvent } = require('../../middlewares/Payment');
    const { Order } = require('../../middlewares/Order');
    const { User } = require('../../middlewares/User');
    const { Wallet } = require('../../middlewares/Wallet');
    const { WalletLedger } = require('../../middlewares/WalletLedger');

    const isNumeric = /^\d+$/.test(rawQuery);
    const numericVal = isNumeric ? parseInt(rawQuery, 10) : null;
    const isMongoId = mongoose.Types.ObjectId.isValid(rawQuery);

    // 1. Search Order directly
    let order = null;
    const orderOr = [];
    if (numericVal !== null) {
        orderOr.push({ orderId: numericVal }, { globalOrderId: numericVal });
    }
    if (isMongoId) {
        orderOr.push({ _id: rawQuery });
    }
    if (orderOr.length > 0) {
        order = await Order.findOne({ $or: orderOr }).lean();
    }

    // 2. Search Payment
    let payment = null;
    const paymentOr = [
        { providerTransactionId: rawQuery },
        { providerOrderId: rawQuery },
        { specialReference: rawQuery },
        { providerIntentionId: rawQuery },
    ];
    if (numericVal !== null) {
        paymentOr.push({ orderNumericId: numericVal });
    }
    if (isMongoId) {
        paymentOr.push({ _id: rawQuery }, { orderId: rawQuery }, { checkoutSessionId: rawQuery });
    }
    if (order && order._id) {
        paymentOr.push({ orderId: order._id }, { orderId: String(order._id) });
    }

    payment = await Payment.findOne({ $or: paymentOr }).sort({ createdAt: -1 }).lean();

    // 3. If Payment not found by direct fields, search via PaymentEvents (e.g. Paymob internal order_id)
    if (!payment) {
        const matchingEvent = await PaymentEvent.findOne({
            $or: [
                { providerEventId: rawQuery },
                { 'payloadSummary.order_id': rawQuery },
                { 'payloadSummary.id': rawQuery },
                { 'payloadSummary.transactionId': rawQuery },
            ],
            paymentId: { $ne: null },
        }).lean();

        if (matchingEvent && matchingEvent.paymentId) {
            payment = await Payment.findById(matchingEvent.paymentId).lean();
        }
    }

    // 4. If payment was found first, resolve Order
    if (!order && payment) {
        if (payment.orderId) {
            order = await Order.findById(payment.orderId).lean();
        }
        if (!order && payment.orderNumericId) {
            order = await Order.findOne({ orderId: payment.orderNumericId }).lean();
        }
    }

    if (!order && !payment) {
        return res.status(404).json({
            success: false,
            message: `لم يتم العثور على أي سجل طلب أو دفع مطابق للقيمة "${rawQuery}"`,
        });
    }

    // 5. Payment Events Timeline
    let paymentEvents = [];
    const eventQueryOr = [];
    if (payment?._id) eventQueryOr.push({ paymentId: payment._id });
    if (payment?.providerTransactionId) eventQueryOr.push({ providerEventId: payment.providerTransactionId });
    if (order?._id) eventQueryOr.push({ orderId: order._id });

    if (eventQueryOr.length > 0) {
        paymentEvents = await PaymentEvent.find({ $or: eventQueryOr }).sort({ createdAt: 1 }).lean();
    }

    // 6. Fetch Client & Representative Details
    const clientId = order?.clientId || payment?.userId;
    const repId = order?.representativeId;

    let clientUser = null;
    let repUser = null;
    if (clientId && mongoose.Types.ObjectId.isValid(clientId)) {
        clientUser = await User.findById(clientId).select('firstName lastName fullName phone governorate').lean();
    }
    if (repId && mongoose.Types.ObjectId.isValid(repId)) {
        repUser = await User.findById(repId).select('firstName lastName fullName phone vehicleNumber vehicleModel').lean();
    }

    // 7. Wallet & Ledger Inspection (Double Refund Check)
    let clientWallet = null;
    let relevantLedgers = [];
    if (clientId) {
        clientWallet = await Wallet.findOne({ userId: String(clientId) }).select('balanceFils').lean();
        relevantLedgers = await WalletLedger.find({
            $or: [
                { orderId: order?._id },
                { paymentId: payment?._id },
                { reference: new RegExp(String(order?.orderId || payment?.providerTransactionId || rawQuery), 'i') },
            ],
        }).sort({ createdAt: -1 }).lean();
    }

    // 8. Financial & Refund Analysis
    const paymentStatus = payment?.status || (order?.paymentStatus === 'paid' ? 'PAID' : (order?.paymentStatus || 'PENDING'));
    const isPaid = paymentStatus === 'PAID' || paymentStatus === 'REFUNDED' || paymentStatus === 'PARTIALLY_REFUNDED' || order?.paymentStatus === 'paid' || order?.paymentStatus === 'refunded';

    const refundedPiastres = payment?.refundedAmountPiastres || 0;
    const isRefunded = paymentStatus === 'REFUNDED' || refundedPiastres > 0 || order?.paymentStatus === 'refunded';
    const isFullRefund = payment ? (refundedPiastres >= (payment.amountPiastres || 0) && refundedPiastres > 0) : (order?.paymentStatus === 'refunded');

    // Extract Paymob Order ID
    let paymobOrderId = payment?.providerOrderId || null;
    if (!paymobOrderId && paymentEvents.length > 0) {
        for (const ev of paymentEvents) {
            if (ev.payloadSummary?.order_id) {
                paymobOrderId = String(ev.payloadSummary.order_id);
                break;
            }
        }
    }

    let refundMethod = payment?.metadata?.refundMethod || null;
    let refundPreference = payment?.metadata?.refundPreference || null;
    let isVoided = false;

    // Detect if VOID was executed
    if (paymentEvents.some(ev => ev.payloadSummary?.is_voided === true || ev.message?.includes('VOID') || payment?.metadata?.refundMethod === 'CARD_GATEWAY')) {
        if (payment?.metadata?.refundMethod === 'CARD_GATEWAY') {
            isVoided = true;
        }
    }

    // Double refund verification
    const walletRefundCredit = relevantLedgers.find(l => l.type === 'CREDIT' && (l.source === 'ORDER_REFUND' || l.source === 'ORDER_RECOVERY_REFUND'));
    const cancellationFeeDebit = relevantLedgers.find(l => l.type === 'DEBIT' && l.reference?.includes('CANCEL_FEE'));
    const hasDoubleRefundRisk = Boolean(isRefunded && refundMethod === 'CARD_GATEWAY' && walletRefundCredit);

    let verdict = '';
    if (isRefunded) {
        if (refundMethod === 'CARD_GATEWAY' || isVoided) {
            verdict = 'تم إلغاء العملية واسترداد كامل المبلغ بنجاح عبر فك حجز البطاقة البنكية (VOID / Card Gateway) دون إيداع بالمحفظة.';
        } else if (refundMethod === 'APP_WALLET' || payment?.provider === 'app_wallet') {
            verdict = 'تم استرداد المبلغ بنجاح وإيداعه في محفظة العميل داخل التطبيق.';
        } else {
            verdict = 'تم استرداد المبلغ بنجاح للعميل.';
        }
    } else if (isPaid) {
        verdict = 'الطلب مدفوع بنجاح بالكامل ولم يتم استرداد أو إلغاء الدفعة.';
    } else {
        verdict = 'الطلب غير مدفوع أو بانتظار إتمام عملية الدفع.';
    }

    return res.status(200).json({
        success: true,
        data: {
            searchQuery: rawQuery,
            verdict,
            order: order ? {
                orderId: order.orderId,
                mongoId: String(order._id),
                status: order.status,
                statusArabic: _translateOrderStatus(order.status),
                paymentStatus: order.paymentStatus || 'unknown',
                paymentStatusArabic: _translatePaymentStatus(order.paymentStatus),
                paymentMethod: order.paymentMethod || 'cash',
                totalPriceEgp: order.totalPrice != null ? Number(order.totalPrice) : (order.totalDeliveryPrice ? order.totalDeliveryPrice / 1000 : 0),
                cancellationReason: order.cancellationReason || null,
                cancellationFeeApplied: Boolean(order.cancellationFeeApplied),
                cancellationFeeEgp: (order.cancellationFeeFils || 0) / 1000,
                createdAt: order.createdAt,
                updatedAt: order.updatedAt,
                client: clientUser ? {
                    name: `${clientUser.firstName || ''} ${clientUser.lastName || ''}`.trim() || clientUser.fullName || 'عميل',
                    phone: clientUser.phone || '',
                    governorate: clientUser.governorate || '',
                } : null,
                representative: repUser ? {
                    name: `${repUser.firstName || ''} ${repUser.lastName || ''}`.trim() || repUser.fullName || 'مندوب',
                    phone: repUser.phone || '',
                    vehicleNumber: repUser.vehicleNumber || '',
                } : null,
            } : null,
            payment: payment ? {
                paymentId: String(payment._id),
                status: payment.status,
                statusArabic: _translatePaymentStatus(payment.status),
                isPaid,
                amountEgp: (payment.amountPiastres || 0) / 100,
                amountPiastres: payment.amountPiastres,
                paymentMethod: payment.paymentMethod || 'CARD',
                provider: payment.provider || 'paymob',
                providerTransactionId: payment.providerTransactionId || null,
                paymobOrderId: paymobOrderId,
                providerIntentionId: payment.providerIntentionId || null,
                integrationId: payment.integrationId || null,
                sourceType: payment.metadata?.sourceType || null,
                sourceSubType: payment.metadata?.sourceSubType || null,
                paidAt: payment.paidAt,
                createdAt: payment.createdAt,
            } : null,
            refund: {
                isRefunded,
                isFullRefund,
                refundStatus: payment?.metadata?.refundStatus || (isRefunded ? 'CONFIRMED' : 'NONE'),
                refundedAmountEgp: refundedPiastres / 100,
                refundedAmountPiastres: refundedPiastres,
                refundMethod: refundMethod || (isRefunded ? 'CARD_GATEWAY' : null),
                refundMethodArabic: _translateRefundMethod(refundMethod, isVoided),
                refundPreference: refundPreference || null,
                isVoided,
                refundedAt: payment?.refundedAt || null,
                refundPendingSettlement: Boolean(payment?.metadata?.refundPendingSettlement),
            },
            walletAudit: {
                clientBalanceEgp: clientWallet ? clientWallet.balanceFils / 1000 : null,
                hasCancellationFee: Boolean(cancellationFeeDebit),
                cancellationFeeEgp: cancellationFeeDebit ? (cancellationFeeDebit.amountFils || 0) / 1000 : 0,
                hasWalletRefundCredited: Boolean(walletRefundCredit),
                walletRefundAmountEgp: walletRefundCredit ? (walletRefundCredit.amountFils || 0) / 1000 : 0,
                hasDoubleRefundRisk,
            },
            events: paymentEvents.map(e => ({
                id: String(e._id),
                eventType: e.eventType,
                eventTypeArabic: _translateEventType(e.eventType),
                message: e.message,
                provider: e.provider,
                providerEventId: e.providerEventId,
                createdAt: e.createdAt,
                details: e.payloadSummary || null,
            })),
        },
    });
});

module.exports = {
    createPayment,
    paymobWebhook,
    paymobRedirect,
    getPaymentStatus,
    refundPayment,
    auditPaymentByOrder,
};
