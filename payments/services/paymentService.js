/**
 * payments/services/paymentService.js
 * Core payment domain service — provider-agnostic business logic.
 *
 * This service owns:
 *  - Payment creation (idempotency, duplicate prevention)
 *  - State transitions (enforcing the state machine)
 *  - Webhook processing (atomically with DB transactions)
 *  - Refund management
 *  - Audit event recording
 *
 * It delegates all Paymob-specific concerns to paymob.service.js.
 * A future provider (Stripe, Fawry, etc.) would add a new provider service
 * without changing this file.
 */

'use strict';

const mongoose = require('mongoose');
const { Payment, PaymentEvent, isLegalTransition } = require('../../middlewares/Payment');
const { Order } = require('../../middlewares/Order');
const { User }  = require('../../middlewares/User');
const paymobService = require('../providers/paymob/paymob.service');
const paymobMapper  = require('../providers/paymob/paymob.mapper');
const paymobConfig  = require('../config/paymobConfig');
const { filsToEgpPiastres, piastresToEgp, isValidPiastres } = require('../utils/money');
const {
    PAYMENT_ERROR_CODES,
    PAYMENT_EXPIRY_MINUTES,
    PAYMENT_PROVIDERS,
    CURRENCY,
} = require('../constants/paymentConstants');
const logger   = require('../../utils/logger');
const ApiError = require('../../utils/ApiError');

// ─── Payable order statuses ───────────────────────────────────────────────────
// An order must be in one of these statuses to accept a payment.
const PAYABLE_ORDER_STATUSES = Object.freeze([
    'waiting',
    'pending',
    'accepted',
]);

// ─── Public Service Methods ───────────────────────────────────────────────────

/**
 * Create a new payment intent for an order.
 *
 * Idempotency rules:
 *  - If a valid non-expired PENDING payment already exists → return it (mobile retry safe).
 *  - If the order is already PAID → throw ORDER_ALREADY_PAID.
 *  - Otherwise → create a new payment record and a Paymob intention.
 *
 * Amount security:
 *  - The authoritative amount is ALWAYS loaded from the Order document.
 *  - The client CANNOT pass an amount — we ignore any client-supplied amount.
 *
 * @param {object} params
 * @param {string} params.orderId   - MongoDB _id of the order (from route param)
 * @param {string} params.userId    - Authenticated user's ID (from JWT — never from body)
 * @param {string} params.requestId - Correlation ID
 * @returns {Promise<{ paymentId, status, clientSecret, expiresAt }>}
 */
async function createPayment({ orderId, userId, requestId }) {
    // 1. Load Order — authoritative source of amount and ownership
    const order = await Order.findById(orderId).lean();
    if (!order) {
        throw new ApiError(404, 'الطلب غير موجود', PAYMENT_ERROR_CODES.ORDER_NOT_FOUND);
    }

    // 2. Authorization — user must own this order
    const orderOwner = (order.clientId || order.userId || '').toString();
    if (orderOwner !== userId.toString()) {
        logger.warn('[PaymentService] Unauthorized payment attempt', {
            requestId,
            orderId,
            userId,
            orderOwner,
        });
        throw new ApiError(403, 'غير مسموح لك بالدفع لهذا الطلب', PAYMENT_ERROR_CODES.PAYMENT_UNAUTHORIZED);
    }

    // 3. Order must be in a payable state
    if (!PAYABLE_ORDER_STATUSES.includes(order.status)) {
        throw new ApiError(
            422,
            `لا يمكن الدفع لطلب بحالة "${order.status}"`,
            PAYMENT_ERROR_CODES.ORDER_NOT_PAYABLE
        );
    }

    // 4. Check if order already has a successful payment
    const paidPayment = await Payment.findOne({
        orderId: order._id,
        status: 'PAID',
    }).lean();
    if (paidPayment) {
        throw new ApiError(409, 'هذا الطلب مدفوع بالفعل', PAYMENT_ERROR_CODES.ORDER_ALREADY_PAID);
    }

    // 5. Idempotency — return existing valid pending payment if present
    const existingPending = await Payment.findOne({
        orderId: order._id,
        status:  'PENDING',
        expiresAt: { $gt: new Date() },
    }).lean();

    if (existingPending) {
        logger.info('[PaymentService] Returning existing pending payment', {
            requestId,
            paymentId:  existingPending._id,
            orderId,
        });
        // Re-create a fresh Paymob intention since the client_secret is not stored (for security)
        // We create a new intention but reuse the same payment record's specialReference
        return _refreshPendingIntention(existingPending, order, userId, requestId);
    }

    // 6. Authoritative amount — from the Order, NEVER from the client
    const amountPiastres = _calculateOrderAmountPiastres(order, requestId);

    // 7. Load user for billing data
    const user = await User.findById(userId).lean();
    if (!user) {
        throw new ApiError(404, 'المستخدم غير موجود', PAYMENT_ERROR_CODES.PAYMENT_UNAUTHORIZED);
    }

    // 8. Create the Payment record first (PENDING), then call Paymob
    //    If Paymob fails, we have a PENDING payment we can retry.
    const payment = new Payment({
        orderId:         order._id,
        orderNumericId:  order.orderId,
        userId:          userId.toString(),
        provider:        PAYMENT_PROVIDERS.PAYMOB,
        amountPiastres,
        currency:        CURRENCY.EGP,
        integrationId:   paymobConfig.integrationId,
        status:          'PENDING',
    });

    // Special reference links our Payment → Paymob intention
    payment.specialReference = `pay_${payment._id}`;
    await payment.save();

    logger.info('[PaymentService] Payment record created', {
        requestId,
        paymentId:   payment._id,
        orderId,
        amountPiastres,
    });

    // 9. Record PAYMENT_CREATED audit event
    await _recordEvent({
        paymentId:  payment._id,
        orderId:    order._id,
        eventType:  'PAYMENT_CREATED',
        provider:   'system',
        requestId,
        message:    `Payment record created for order ${order.orderId}`,
        payloadSummary: { amountPiastres, currency: CURRENCY.EGP },
    });

    // 10. Create Paymob intention
    let intention;
    try {
        intention = await paymobService.createPaymobIntention({
            amountPiastres,
            specialReference: payment.specialReference,
            user,
            requestId,
        });
    } catch (err) {
        // Mark payment as FAILED if Paymob is unavailable
        await Payment.findByIdAndUpdate(payment._id, {
            status:    'FAILED',
            failedAt:  new Date(),
            failureReason: 'Paymob intention creation failed',
        });
        await _recordEvent({
            paymentId: payment._id,
            orderId:   order._id,
            eventType: 'PAYMENT_FAILED',
            provider:  'paymob',
            requestId,
            message:   'Paymob intention creation failed',
        });
        throw err;
    }

    // 11. Update payment with Paymob intention details
    await Payment.findByIdAndUpdate(payment._id, {
        providerIntentionId: intention.providerIntentionId,
        providerOrderId:     intention.providerOrderId,
        expiresAt:           intention.expiresAt,
    });

    await _recordEvent({
        paymentId:  payment._id,
        orderId:    order._id,
        eventType:  'PAYMENT_INTENTION_CREATED',
        provider:   'paymob',
        requestId,
        message:    `Paymob intention created`,
        payloadSummary: {
            providerIntentionId: intention.providerIntentionId,
            providerOrderId:     intention.providerOrderId,
        },
    });

    logger.info('[PaymentService] PAYMENT_INTENTION_CREATED', {
        requestId,
        paymentId: payment._id,
        intentionId: intention.providerIntentionId,
    });

    return {
        paymentId:    payment._id,
        status:       'PENDING',
        clientSecret: intention.clientSecret,
        checkoutUrl:  intention.checkoutUrl,
        publicKey:    intention.publicKey || paymobConfig.publicKey,
        expiresAt:    intention.expiresAt,
    };
}

/**
 * Process a verified Paymob transaction webhook atomically.
 *
 * This is the authoritative payment confirmation path.
 * Called ONLY after HMAC verification has passed.
 *
 * Idempotency:
 *  - Uses a unique index on (provider, providerTransactionId).
 *  - If the transaction was already processed, returns safely without duplicating.
 *  - Uses findOneAndUpdate with status condition to prevent race conditions.
 *
 * @param {object} params
 * @param {object} params.transaction - Validated Paymob transaction from webhook
 * @param {string} params.requestId
 * @returns {Promise<void>}
 */
async function processWebhookTransaction({ transaction, requestId }) {
    const transactionId = String(transaction.id);
    const specialRef    = transaction.special_reference
                       || transaction.order?.merchant_order_id
                       || transaction.merchant_order_id
                       || transaction.extras?.payment_reference
                       || transaction.extras?.merchant_order_id
                       || null;

    // 1. Find our Payment by special_reference OR providerTransactionId OR clean ID
    let payment = null;

    if (specialRef) {
        payment = await Payment.findOne({ specialReference: specialRef }).lean();
        if (!payment && typeof specialRef === 'string' && specialRef.startsWith('topup_')) {
            const cleanId = specialRef.replace(/^topup_/, '');
            if (mongoose.Types.ObjectId.isValid(cleanId)) {
                payment = await Payment.findById(cleanId).lean();
            }
        }
    }

    if (!payment && transaction.order?.id) {
        payment = await Payment.findOne({ providerOrderId: String(transaction.order.id) }).lean();
    }

    if (!payment) {
        logger.warn('[PaymentService] No matching payment found for webhook', {
            requestId,
            transactionId,
            specialRef,
            paymobOrderId: transaction.order?.id,
        });
        // Return without error — Paymob may send callbacks for test/other orders.
        return;
    }

    // 2. Validate callback fields (amount, currency, integrationId)
    // This throws ApiError for mismatches — the webhook handler will log and return 400.
    const { isSuccess, isFailed, isVoided, isPending } = paymobService.validateTransactionCallback({
        transaction,
        storedPayment: payment,
        requestId,
    });

    const safePayload = paymobMapper.buildSafeCallbackSummary(transaction);

    // 3. Idempotency — detect if this exact transaction was already processed
    const alreadyProcessed = await Payment.findOne({
        provider:              PAYMENT_PROVIDERS.PAYMOB,
        providerTransactionId: transactionId,
    }).lean();

    if (alreadyProcessed) {
        logger.info('[PaymentService] Duplicate webhook received — already processed', {
            requestId,
            transactionId,
            paymentId: alreadyProcessed._id,
            currentStatus: alreadyProcessed.status,
        });
        await _recordEvent({
            paymentId:  alreadyProcessed._id,
            orderId:    alreadyProcessed.orderId,
            eventType:  'PAYMENT_DUPLICATE_CALLBACK',
            provider:   'paymob',
            providerEventId: transactionId,
            requestId,
            payloadSummary: safePayload,
            message:    'Duplicate webhook — already processed',
        });
        return; // Safe no-op
    }

    // 4. Log receipt
    await _recordEvent({
        paymentId:  payment._id,
        orderId:    payment.orderId,
        eventType:  'PAYMENT_WEBHOOK_RECEIVED',
        provider:   'paymob',
        providerEventId: transactionId,
        requestId,
        payloadSummary: safePayload,
    });

    // 5. Atomic state transition using findOneAndUpdate with status precondition.
    //    This prevents two concurrent webhooks from both transitioning PENDING → PAID.
    if (isSuccess) {
        await _processSuccessfulTransaction({ payment, transaction, transactionId, safePayload, requestId });
    } else if (isPending) {
        // Still pending — no state change needed, just log
        logger.info('[PaymentService] Transaction still pending', { requestId, transactionId });
    } else {
        await _processFailedTransaction({ payment, transaction, transactionId, safePayload, isVoided, requestId });
    }
}

/**
 * Initiate a refund for a paid payment.
 *
 * @param {object} params
 * @param {string} params.paymentId    - MongoDB _id of Payment
 * @param {number} params.amountPiastres - Amount to refund in piastres (null = full refund)
 * @param {string} params.requestedBy  - Admin user ID
 * @param {string} params.requestId
 * @returns {Promise<object>} Updated payment document
 */
async function refundPayment({ paymentId, amountPiastres, requestedBy, requestId }) {
    const payment = await Payment.findById(paymentId).lean();
    if (!payment) {
        throw new ApiError(404, 'سجل الدفع غير موجود', PAYMENT_ERROR_CODES.PAYMENT_NOT_FOUND);
    }

    if (payment.status !== 'PAID' && payment.status !== 'PARTIALLY_REFUNDED') {
        throw new ApiError(
            422,
            'لا يمكن استرداد دفعة غير مكتملة',
            PAYMENT_ERROR_CODES.ORDER_NOT_PAYABLE
        );
    }

    const remainingRefundable = payment.amountPiastres - (payment.refundedAmountPiastres || 0);

    // Default to full refund of remaining amount
    const refundAmount = amountPiastres ?? remainingRefundable;

    if (!isValidPiastres(refundAmount)) {
        throw new ApiError(400, 'مبلغ الاسترداد غير صالح', PAYMENT_ERROR_CODES.REFUND_AMOUNT_INVALID);
    }
    if (refundAmount > remainingRefundable) {
        throw new ApiError(422, 'مبلغ الاسترداد يتجاوز المبلغ المدفوع', PAYMENT_ERROR_CODES.REFUND_EXCEEDS_PAID);
    }

    const isAppWallet = payment.provider === 'app_wallet' || payment.paymentMethod === 'APP_WALLET';

    await _recordEvent({
        paymentId:         payment._id,
        orderId:           payment.orderId || null,
        checkoutSessionId: payment.checkoutSessionId || null,
        eventType:         'PAYMENT_REFUND_REQUESTED',
        provider:          payment.provider || 'system',
        requestId,
        message:           `Refund of ${refundAmount} piastres requested by ${requestedBy}`,
        payloadSummary:    { refundAmount, requestedBy, isAppWallet },
    });

    // Atomically reserve the refund amount on the Payment document
    // Ensures that concurrent refund requests cannot exceed the original payment amount
    const reservedPayment = await Payment.findOneAndUpdate(
        {
            _id: payment._id,
            status: { $in: ['PAID', 'PARTIALLY_REFUNDED'] },
            $expr: {
                $lte: [
                    { $add: [{ $ifNull: ['$refundedAmountPiastres', 0] }, refundAmount] },
                    '$amountPiastres',
                ],
            },
        },
        {
            $inc: { refundedAmountPiastres: refundAmount },
        },
        { new: true }
    );

    if (!reservedPayment) {
        throw new ApiError(
            422,
            'مبلغ الاسترداد يتجاوز المبلغ المتبقي القابل للاسترداد، أو أن الدفعة غير مؤهلة',
            PAYMENT_ERROR_CODES.REFUND_EXCEEDS_PAID
        );
    }

    try {
        if (isAppWallet) {
            // Internal wallet refund
            const { piastresToFils } = require('../utils/money');
            const { refundToWallet } = require('./walletPaymentService');
            const amountFils = piastresToFils(refundAmount);

            await refundToWallet({
                orderId:    payment.orderId,
                amountFils,
                userId:     payment.userId,
                paymentId:  payment._id,
                requestId,
            });
        } else {
            // Paymob refund
            if (!payment.providerTransactionId) {
                throw new ApiError(500, 'معرف المعاملة غير متاح للاسترداد', PAYMENT_ERROR_CODES.PAYMENT_PROVIDER_ERROR);
            }

            await paymobService.requestRefund({
                providerTransactionId: payment.providerTransactionId,
                amountPiastres:        refundAmount,
                requestId,
            });
        }
    } catch (refundErr) {
        // Rollback the reserved refund amount on failure
        await Payment.findByIdAndUpdate(payment._id, {
            $inc: { refundedAmountPiastres: -refundAmount },
        }).catch(() => {});
        throw refundErr;
    }

    const newRefundedTotal = reservedPayment.refundedAmountPiastres;
    const isFullRefund     = newRefundedTotal >= reservedPayment.amountPiastres;
    const newStatus        = isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

    const updatedPayment = await Payment.findByIdAndUpdate(
        payment._id,
        {
            $set:  {
                status:      newStatus,
                refundedAt:  isFullRefund ? new Date() : undefined,
            },
        },
        { new: true }
    ).lean();

    if (payment.orderId) {
        await Order.findByIdAndUpdate(payment.orderId, {
            $set: { paymentStatus: isFullRefund ? 'refunded' : 'paid' },
        }).catch(() => {});
    }

    await _recordEvent({
        paymentId:         payment._id,
        orderId:           payment.orderId || null,
        checkoutSessionId: payment.checkoutSessionId || null,
        eventType:         'PAYMENT_REFUND_SUCCEEDED',
        provider:          payment.provider || 'system',
        requestId,
        message:           `Refund of ${refundAmount} piastres succeeded. New status: ${newStatus}`,
        payloadSummary:    { refundAmount, newStatus, isAppWallet },
    });

    logger.info('[PaymentService] PAYMENT_REFUND_SUCCEEDED', {
        requestId,
        paymentId: payment._id,
        refundAmount,
        newStatus,
        isAppWallet,
    });

    return updatedPayment;
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Refresh a Paymob intention for an existing pending payment.
 * Used when the mobile retries createPayment with a still-valid pending payment.
 * We do NOT create a new Payment record — just a new Paymob intention.
 */
async function _refreshPendingIntention(existingPayment, order, userId, requestId) {
    const user = await User.findById(userId).lean();

    const intention = await paymobService.createPaymobIntention({
        amountPiastres:   existingPayment.amountPiastres,
        specialReference: existingPayment.specialReference,
        user,
        requestId,
    });

    // Update the intention details on the existing payment
    await Payment.findByIdAndUpdate(existingPayment._id, {
        providerIntentionId: intention.providerIntentionId,
        providerOrderId:     intention.providerOrderId,
        expiresAt:           intention.expiresAt,
    });

    logger.info('[PaymentService] PAYMENT_CHECKOUT_STARTED (retry)', {
        requestId,
        paymentId: existingPayment._id,
        intentionId: intention.providerIntentionId,
    });

    return {
        paymentId:    existingPayment._id,
        status:       'PENDING',
        clientSecret: intention.clientSecret,
        checkoutUrl:  intention.checkoutUrl,
        publicKey:    intention.publicKey || paymobConfig.publicKey,
        expiresAt:    intention.expiresAt,
    };
}

/**
 * Calculate the authoritative payment amount in piastres from the Order.
 * Uses totalDeliveryPrice (in fils from the DB).
 *
 * The project stores amounts in "fils" (milli-EGP: 1000 fils = 1 EGP).
 * Paymob expects integer piastres (1 EGP = 100 piastres).
 */
function _calculateOrderAmountPiastres(order, requestId) {
    const rawAmount = order.totalDeliveryPrice || order.totalPrice || 0;

    if (rawAmount <= 0) {
        logger.warn('[PaymentService] Order has zero or negative amount', {
            requestId,
            orderId: order._id,
            totalDeliveryPrice: order.totalDeliveryPrice,
        });
        throw new ApiError(422, 'مبلغ الطلب غير صالح للدفع', PAYMENT_ERROR_CODES.ORDER_NOT_PAYABLE);
    }

    const piastres = filsToEgpPiastres(rawAmount);
    if (!isValidPiastres(piastres)) {
        throw new ApiError(422, 'تعذر تحويل مبلغ الطلب للدفع', PAYMENT_ERROR_CODES.ORDER_NOT_PAYABLE);
    }

    return piastres;
}

/**
 * Atomically process a successful transaction webhook.
 * Dispatches by payment.purpose:
 *  1. WALLET_TOPUP: credits customer wallet via WalletPaymentService, never touches Order.
 *  2. ORDER_PAYMENT with checkoutSessionId: creates final Order from CheckoutSession snapshot.
 *  3. Legacy ORDER_PAYMENT with orderId: updates existing Order status.
 */
async function _processSuccessfulTransaction({ payment, transaction, transactionId, safePayload, requestId }) {
    if (payment.purpose === 'WALLET_TOPUP') {
        const { processWalletTopup } = require('./walletPaymentService');
        await processWalletTopup({
            payment,
            transaction,
            providerTransactionId: transactionId,
            requestId,
        });
        return;
    }

    if (payment.checkoutSessionId) {
        await _processCheckoutSessionPayment({
            payment,
            transaction,
            transactionId,
            safePayload,
            requestId,
        });
        return;
    }

    // Legacy fallback: existing orderId
    await _processLegacyOrderPayment({
        payment,
        transaction,
        transactionId,
        safePayload,
        requestId,
    });
}

/**
 * Finalize Order from CheckoutSession upon verified successful payment.
 */
async function _processCheckoutSessionPayment({ payment, transaction, transactionId, safePayload, requestId }) {
    const { CheckoutSession } = require('../../middlewares/CheckoutSession');
    const { _createOrderFromSnapshot } = require('./walletPaymentService');
    const { consumeDiscountAfterSuccessfulOrder } = require('../../middlewares/Discount');

    let mongoSession = null;
    let inTransaction = false;
    try {
        mongoSession = await mongoose.startSession();
        mongoSession.startTransaction();
        inTransaction = true;
    } catch (_) {
        mongoSession = null;
        inTransaction = false;
    }

    try {
        // Atomic update on payment: only transition from PENDING
        const updatedPayment = await Payment.findOneAndUpdate(
            { _id: payment._id, status: 'PENDING' },
            {
                $set: {
                    status:                'PAID',
                    providerTransactionId: transactionId,
                    paidAt:                new Date(),
                    metadata: {
                        sourceType:    transaction.source_data?.type,
                        sourceSubType: transaction.source_data?.sub_type,
                    },
                },
            },
            { new: true, session: mongoSession || undefined }
        );

        if (!updatedPayment) {
            if (inTransaction) {
                await mongoSession.abortTransaction();
                mongoSession.endSession();
            }
            logger.info('[PaymentService] Checkout payment already transitioned (concurrent webhook)', {
                requestId, paymentId: payment._id, transactionId,
            });
            return;
        }

        const session = await CheckoutSession.findById(payment.checkoutSessionId).session(mongoSession || undefined);
        if (!session) {
            if (inTransaction) {
                await mongoSession.abortTransaction();
                mongoSession.endSession();
            }
            logger.error('[PaymentService] CheckoutSession not found during webhook completion', {
                requestId, checkoutSessionId: payment.checkoutSessionId,
            });
            return;
        }

        if (session.status === 'COMPLETED' || session.finalOrderId) {
            if (inTransaction) {
                await mongoSession.abortTransaction();
                mongoSession.endSession();
            }
            logger.info('[PaymentService] CheckoutSession already completed (idempotent)', {
                requestId, checkoutSessionId: session._id, finalOrderId: session.finalOrderId,
            });
            return;
        }

        // Create final Order from snapshot
        const finalOrder = await _createOrderFromSnapshot({
            session,
            paymentId:     updatedPayment._id,
            paymentMethod: payment.paymentMethod === 'MOBILE_WALLET' ? 'mobile_wallet' : 'online',
            requestId,
            mongoSession,
        });

        // Update CheckoutSession to COMPLETED
        await CheckoutSession.findByIdAndUpdate(
            session._id,
            {
                status:              'COMPLETED',
                finalOrderId:        finalOrder._id,
                finalOrderNumericId: finalOrder.orderId,
                paymentId:           updatedPayment._id,
                paidAt:              new Date(),
                completedAt:         new Date(),
            },
            { session: mongoSession || undefined }
        );

        // Link Order to Payment
        await Payment.findByIdAndUpdate(
            updatedPayment._id,
            {
                orderId:        finalOrder._id,
                orderNumericId: finalOrder.orderId,
            },
            { session: mongoSession || undefined }
        );

        if (inTransaction) {
            await mongoSession.commitTransaction();
            mongoSession.endSession();
        }

        // Consume discount if applicable (outside transaction)
        if (session.discountCode || (session.discountAmountFils && session.discountAmountFils > 0)) {
            await consumeDiscountAfterSuccessfulOrder({
                clientId:       session.userId,
                discountCode:   session.discountCode,
                discountType:   session.discountType,
                discountAmount: session.discountAmountFils,
            }).catch((err) => {
                logger.warn('[PaymentService] Could not consume discount after order creation', {
                    requestId, err: err.message,
                });
            });
        }

        await _recordEvent({
            paymentId:         updatedPayment._id,
            orderId:           finalOrder._id,
            checkoutSessionId: session._id,
            eventType:         'ORDER_CREATED_AFTER_PAYMENT',
            requestId,
            message:           `Order #${finalOrder.orderId} finalized from checkout session snapshot`,
            payloadSummary:    { orderNumericId: finalOrder.orderId, transactionId },
        });

        logger.info('[PaymentService] Checkout payment and order creation finalized', {
            requestId,
            paymentId:      updatedPayment._id,
            orderId:        finalOrder._id,
            orderNumericId: finalOrder.orderId,
            sessionId:      session._id,
        });
    } catch (orderErr) {
        if (inTransaction) {
            await mongoSession.abortTransaction();
            mongoSession.endSession();
        }
        logger.error('[PaymentService] Failed to create Order from snapshot after payment', {
            requestId, checkoutSessionId: payment.checkoutSessionId, err: orderErr.message,
        });
        await _recordEvent({
            paymentId:         payment._id,
            checkoutSessionId: payment.checkoutSessionId,
            eventType:         'PAYMENT_FAILED',
            requestId,
            message:           `Order creation failed post-payment: ${orderErr.message}`,
        });
    }

    await _recordEvent({
        paymentId:         updatedPayment._id,
        orderId:           finalOrder._id,
        checkoutSessionId: session._id,
        eventType:         'PAYMENT_SUCCESS',
        provider:          'paymob',
        providerEventId:   transactionId,
        requestId,
        payloadSummary:    safePayload,
        message:           'Payment confirmed and order created via webhook',
    });

    await _recordEvent({
        paymentId:         updatedPayment._id,
        orderId:           finalOrder._id,
        checkoutSessionId: session._id,
        eventType:         'ORDER_CREATED_AFTER_PAYMENT',
        requestId,
        message:           `Order #${finalOrder.orderId} created after Paymob payment`,
        payloadSummary:    { orderNumericId: finalOrder.orderId },
    });

    logger.info('[PaymentService] PAYMENT_SUCCESS & ORDER_CREATED_AFTER_PAYMENT', {
        requestId,
        paymentId:      updatedPayment._id,
        orderId:        finalOrder._id,
        orderNumericId: finalOrder.orderId,
        transactionId,
    });
}

/**
 * Legacy flow: update existing Order payment status.
 */
async function _processLegacyOrderPayment({ payment, transaction, transactionId, safePayload, requestId }) {
    const updated = await Payment.findOneAndUpdate(
        { _id: payment._id, status: 'PENDING' },
        {
            $set: {
                status:                'PAID',
                providerTransactionId: transactionId,
                paidAt:                new Date(),
                metadata: {
                    sourceType:    transaction.source_data?.type,
                    sourceSubType: transaction.source_data?.sub_type,
                },
            },
        },
        { new: true }
    );

    if (!updated) {
        logger.info('[PaymentService] Payment already processed (concurrent webhook)', {
            requestId,
            paymentId: payment._id,
            transactionId,
        });
        return;
    }

    await _recordEvent({
        paymentId:       payment._id,
        orderId:         payment.orderId,
        eventType:       'PAYMENT_SUCCESS',
        provider:        'paymob',
        providerEventId: transactionId,
        requestId,
        payloadSummary:  safePayload,
        message:         'Payment confirmed via webhook',
    });

    logger.info('[PaymentService] PAYMENT_SUCCESS', {
        requestId,
        paymentId:   payment._id,
        orderId:     payment.orderId,
        transactionId,
        amountPiastres: payment.amountPiastres,
    });

    if (payment.orderId) {
        await Order.findByIdAndUpdate(payment.orderId, {
            $set: { paymentMethod: 'online', paymentStatus: 'paid' },
        });
    }
}

/**
 * Atomically process a failed/voided transaction webhook.
 */
async function _processFailedTransaction({ payment, transaction, transactionId, safePayload, isVoided, requestId }) {
    const failureReason = transaction.data?.message
        || (isVoided ? 'Transaction voided' : 'Transaction failed');

    const updated = await Payment.findOneAndUpdate(
        { _id: payment._id, status: 'PENDING' },
        {
            $set: {
                status:                'FAILED',
                providerTransactionId: transactionId,
                failedAt:              new Date(),
                failureReason:         failureReason.substring(0, 500), // trim for safety
            },
        },
        { new: true }
    );

    if (!updated) {
        logger.info('[PaymentService] Failed transaction — payment not in PENDING state (skipped)', {
            requestId, paymentId: payment._id, transactionId,
        });
        return;
    }

    const eventType = payment.purpose === 'WALLET_TOPUP' ? 'WALLET_TOPUP_FAILED' : 'PAYMENT_FAILED';

    await _recordEvent({
        paymentId:         payment._id,
        orderId:           payment.orderId || null,
        checkoutSessionId: payment.checkoutSessionId || null,
        eventType,
        provider:          'paymob',
        providerEventId:   transactionId,
        requestId,
        payloadSummary:    safePayload,
        message:           failureReason,
    });

    if (payment.checkoutSessionId) {
        const { CheckoutSession } = require('../../middlewares/CheckoutSession');
        await CheckoutSession.findByIdAndUpdate(payment.checkoutSessionId, {
            status:             'FAILED',
            cancellationReason: failureReason,
        }).catch(() => {});
    } else if (payment.orderId) {
        await Order.findByIdAndUpdate(payment.orderId, {
            $set: { paymentStatus: 'failed' },
        }).catch(() => {});
    }

    logger.info(`[PaymentService] ${eventType}`, {
        requestId,
        paymentId: payment._id,
        transactionId,
        reason: failureReason,
    });
}

/**
 * Create an immutable PaymentEvent audit record.
 */
async function _recordEvent({ paymentId, orderId, eventType, provider, providerEventId, requestId, payloadSummary, message }) {
    try {
        await PaymentEvent.create({
            paymentId,
            orderId,
            eventType,
            provider:       provider || 'system',
            providerEventId: providerEventId || null,
            requestId:      requestId || null,
            payloadSummary: payloadSummary || null,
            message:        message || null,
        });
    } catch (err) {
        // Audit logging must never crash the main flow
        logger.error('[PaymentService] Failed to create PaymentEvent', {
            eventType, paymentId, message: err.message,
        });
    }
}

module.exports = {
    createPayment,
    processWebhookTransaction,
    refundPayment,
};
