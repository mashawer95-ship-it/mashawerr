/**
 * payments/services/walletPaymentService.js
 * Customer-facing wallet service for PAYMENT domain operations.
 *
 * This service handles:
 *  1. Wallet top-up via Paymob (called from webhook after HMAC verification)
 *  2. Order payment from wallet (atomic debit + checkout session finalization)
 *  3. Wallet refunds (when an order paid from wallet is cancelled)
 *
 * IMPORTANT: This service works alongside the EXISTING Wallet.js in middlewares/.
 * The existing Wallet.js handles rep commissions, driver earnings, admin adjustments.
 * This service introduces customer-facing payments only.
 *
 * Concurrency protection:
 *  - MongoDB findOneAndUpdate with preconditions for wallet balance
 *  - WalletLedger unique index on reference + providerTransactionId
 *  - Duplicate-write protection at DB level (not just application level)
 *
 * Design decision:
 *  - We do NOT use MongoDB multi-document transactions because the existing
 *    Wallet.js uses wallet.save() (not sessions), and mixing sessions with
 *    existing helpers would risk breaking the established commission/earnings flows.
 *  - Instead we use: atomic findOneAndUpdate + unique DB constraints for idempotency.
 *    This is safe because:
 *      a) WalletLedger.reference is unique — duplicate writes fail at DB level
 *      b) We check Payment.status === 'PENDING' before any write
 *      c) We use $inc on wallet.balanceFils atomically
 */

'use strict';

const mongoose = require('mongoose');
const { Wallet, getOrCreateWallet, dispatchWalletNotification } = require('../../middlewares/Wallet');
const { WalletLedger } = require('../../middlewares/WalletLedger');
const { Payment, PaymentEvent } = require('../../middlewares/Payment');
const { CheckoutSession } = require('../../middlewares/CheckoutSession');
const { Order, getNextGlobalOrderId, getNextTaskId } = require('../../middlewares/Order');
const {
    PAYMENT_ERROR_CODES,
    WALLET_MIN_TOPUP_FILS,
    WALLET_MAX_TOPUP_FILS,
    WALLET_MAX_BALANCE_FILS,
    WALLET_DAILY_TOPUP_LIMIT_FILS,
    ORDER_MIN_PAYMENT_FILS,
    CURRENCY,
} = require('../constants/paymentConstants');
const { piastresToFils, filsToEgpPiastres, isValidFils, filsToEgp } = require('../utils/money');
const logger   = require('../../utils/logger');
const ApiError = require('../../utils/ApiError');

// ─── 1. Process Wallet Top-Up (called by webhook handler) ─────────────────────

/**
 * Credit the wallet after a verified successful Paymob top-up transaction.
 *
 * Idempotency:
 *  - WalletLedger.providerTransactionId has a unique sparse index
 *  - WalletLedger.reference has a unique sparse index
 *  - If duplicate webhook arrives, the second write will fail with a
 *    unique index violation, which we catch and treat as a safe no-op.
 *
 * Atomicity:
 *  - Wallet.balanceFils is updated with $inc (atomic single-document update)
 *  - If the ledger insert fails, the balance is already incremented.
 *    We detect this via the unique index and log a reconciliation alert.
 *
 * @param {object} params
 * @param {object} params.payment          - Payment document (purpose=WALLET_TOPUP, status=PENDING)
 * @param {string} params.providerTransactionId - Paymob transaction ID
 * @param {string} params.requestId
 */
async function processWalletTopup({ payment, transaction, providerTransactionId, requestId }) {
    const userId    = payment.userId;
    const amountFils = piastresToFils(payment.amountPiastres);
    const reference  = `TOPUP_${payment._id}`;

    const paymobConfig = require('../config/paymobConfig');
    const sourceType = (transaction?.source_data?.type || '').toLowerCase();
    const sourceSubType = (transaction?.source_data?.sub_type || '').toLowerCase();
    const callbackIntegrationId = Number(transaction?.integration_id);

    const isWallet = sourceType === 'wallet'
        || sourceType === 'mobile_wallet'
        || (paymobConfig.walletIntegrationId && callbackIntegrationId === Number(paymobConfig.walletIntegrationId));

    const actualPaymentMethod = isWallet ? 'MOBILE_WALLET' : 'CARD';
    const methodArabic = isWallet ? 'محفظة إلكترونية (أرقام كاش)' : 'بطاقة بنكية (فيزا / ماستركارد)';

    logger.info('[WalletPaymentService] Processing wallet top-up credit', {
        requestId,
        paymentId: payment._id,
        userId,
        amountFils,
        providerTransactionId,
        actualPaymentMethod,
    });

    // ── Pre-check: Idempotency by reference or providerTransactionId ────────
    const existingTx = await WalletLedger.findOne({
        $or: [
            { providerTransactionId: String(providerTransactionId) },
            { reference },
        ],
    }).lean();

    if (existingTx) {
        logger.info('[WalletPaymentService] Top-up transaction already processed (idempotent)', {
            requestId,
            paymentId: payment._id,
            providerTransactionId,
        });
        return;
    }

    // NOTE: We intentionally do NOT attempt mongoose.startSession() here.
    // Atlas M0 (free tier) does not support multi-document transactions and
    // startSession() adds latency before failing. Atomicity is guaranteed by:
    //  a) findOneAndUpdate with status:'PENDING' precondition (only one webhook wins)
    //  b) WalletLedger unique index on providerTransactionId + reference (blocks duplicates at DB level)

    try {
        // ── Step 1: Mark Payment as PAID atomically from PENDING ─────────────
        const updatedPayment = await Payment.findOneAndUpdate(
            { _id: payment._id, status: 'PENDING' },
            {
                $set: {
                    status:                'PAID',
                    providerTransactionId: String(providerTransactionId),
                    paymentMethod:         actualPaymentMethod,
                    integrationId:         callbackIntegrationId || payment.integrationId,
                    paidAt:                new Date(),
                    metadata: {
                        sourceType:        transaction?.source_data?.type,
                        sourceSubType:     transaction?.source_data?.sub_type,
                        pan:               transaction?.source_data?.pan,
                    },
                },
            },
            { new: true }
        );

        if (!updatedPayment) {
            logger.info('[WalletPaymentService] Top-up payment already processed (concurrent)', {
                requestId,
                paymentId: payment._id,
                providerTransactionId,
            });
            return; // Safe no-op — another webhook already handled this
        }

        // ── Step 2: Get or create wallet ─────────────────────────────────────
        const wallet = await getOrCreateWallet(userId);

        // ── Step 3: Atomic wallet balance credit ─────────────────────────────
        const updatedWallet = await Wallet.findOneAndUpdate(
            { _id: wallet._id },
            { $inc: { balanceFils: amountFils } },
            { new: true }
        );

        if (!updatedWallet) {
            throw new Error(`Wallet not found during top-up credit for userId ${userId}`);
        }

        const balanceAfter  = updatedWallet.balanceFils;
        const balanceBefore = balanceAfter - amountFils;

        // ── Step 4: Create immutable WalletLedger entry ──────────────────────
        await WalletLedger.create([
            {
                walletId:              wallet._id,
                userId:                String(userId),
                type:                  'CREDIT',
                source:                'PAYMOB_TOPUP',
                amountFils,
                currency:              CURRENCY.EGP,
                balanceBeforeFils:     balanceBefore,
                balanceAfterFils:      balanceAfter,
                status:                'COMPLETED',
                paymentId:             payment._id,
                providerTransactionId: String(providerTransactionId),
                reference,
                description:           `Paymob top-up (${isWallet ? 'أرقام كاش' : 'فيزا'}) — ${(amountFils / 1000).toFixed(2)} EGP`,
                performedBy:           'system',
            },
        ]);

        // ── Step 5: Append to existing Wallet.transactions (backward compat) ─
        updatedWallet.transactions = updatedWallet.transactions || [];
        updatedWallet.transactions.push({
            type:             'credit',
            amountFils,
            balanceAfterFils: balanceAfter,
            description:      `شحن المحفظة عبر Paymob (${methodArabic} - ${(amountFils / 1000).toFixed(2)} ج.م)`,
            refId:            String(payment._id),
            performedBy:      'system',
        });
        await updatedWallet.save().catch(() => {});

        // ── Step 6: Audit events — fired in parallel (non-blocking on critical path) ──
        logger.info('[WalletPaymentService] WALLET_TOPUP_COMPLETED', {
            requestId,
            paymentId:   payment._id,
            userId,
            amountFils,
            balanceAfter,
        });

        // Fire both audit events concurrently — neither is on the critical path
        Promise.all([
            _recordPaymentEvent({
                paymentId:       payment._id,
                eventType:       'WALLET_TOPUP_COMPLETED',
                requestId,
                message:         `Wallet credited ${amountFils} fils. Balance: ${balanceAfter} fils.`,
                payloadSummary:  { amountFils, balanceBefore, balanceAfter },
            }),
            _recordPaymentEvent({
                paymentId:       payment._id,
                eventType:       'WALLET_CREDIT',
                requestId,
                message:         `CREDIT ${amountFils} fils from PAYMOB_TOPUP`,
                payloadSummary:  { amountFils, source: 'PAYMOB_TOPUP' },
            }),
        ]).catch((auditErr) => {
            logger.warn('[WalletPaymentService] Audit event write failed (non-fatal)', {
                requestId, paymentId: payment._id, err: auditErr.message,
            });
        });

    } catch (err) {
        if (err.code === 11000) {
            logger.info('[WalletPaymentService] Duplicate ledger entry (idempotent)', {
                requestId, reference, providerTransactionId,
            });
            return;
        }
        logger.error('[WalletPaymentService] Top-up processing error', {
            requestId,
            paymentId: payment._id,
            err: err.message,
        });
        _recordPaymentEvent({
            paymentId:  payment._id,
            eventType:  'WALLET_INTEGRITY_ERROR',
            requestId,
            message:    `Wallet top-up failed: ${err.message}`,
        }).catch(() => {});
        throw err;
    }

    // ── Step 7: Push notification ───────────────────────────────────────────
    try {
        const { dispatchWalletNotification: notif } = require('../../middlewares/Wallet');
        notif({
            userId,
            type:             'credit',
            amountFils,
            balanceAfterFils: balanceAfter,
            description:      `شحن المحفظة عبر Paymob`,
            refId:            String(payment._id),
        });
    } catch (_) { /* notification is non-fatal */ }
}

// ─── 2. Pay Order from Wallet (atomic) ────────────────────────────────────────

/**
 * Debit wallet and finalize a checkout session atomically.
 *
 * This handles APP_WALLET order payments (no Paymob involved).
 * Atomicity model:
 *  1. Validate checkout session
 *  2. Check wallet balance (with optimistic lock via $inc condition)
 *  3. Debit wallet balance atomically ($inc with $gte precondition)
 *  4. Create WalletLedger debit entry (unique reference prevents duplicate debit)
 *  5. Create Payment record (PAID)
 *  6. Create final Order + items from snapshot
 *  7. Update CheckoutSession to COMPLETED
 *
 * Rollback strategy (partial failure):
 *  - If Order creation fails after wallet debit: we mark payment FAILED
 *    and issue a wallet refund credit + ledger entry. This is a compensating
 *    transaction pattern (saga). A DB-level 2PC transaction is not used to
 *    avoid coupling with the existing Wallet save() pattern.
 *
 * @param {object} params
 * @param {string} params.checkoutSessionId
 * @param {string} params.userId
 * @param {string} params.requestId
 * @returns {Promise<{ orderId, orderNumericId, paymentId }>}
 */
async function payOrderFromWallet({ checkoutSessionId, userId, requestId }) {
    // ── Step 1: Load and validate checkout session ──────────────────────────
    const session = await CheckoutSession.findById(checkoutSessionId);
    if (!session) {
        throw new ApiError(404, 'جلسة الدفع غير موجودة', PAYMENT_ERROR_CODES.CHECKOUT_NOT_FOUND);
    }
    if (session.userId !== String(userId)) {
        throw new ApiError(403, 'غير مسموح', PAYMENT_ERROR_CODES.CHECKOUT_UNAUTHORIZED);
    }
    if (session.status === 'COMPLETED') {
        throw new ApiError(409, 'تم معالجة هذا الدفع بالفعل', PAYMENT_ERROR_CODES.CHECKOUT_ALREADY_COMPLETED);
    }
    if (session.status === 'CANCELLED' || session.status === 'FAILED') {
        throw new ApiError(422, 'جلسة الدفع ملغية أو فاشلة', PAYMENT_ERROR_CODES.CHECKOUT_NOT_FOUND);
    }
    if (session.expiresAt < new Date()) {
        await CheckoutSession.findByIdAndUpdate(checkoutSessionId, { status: 'EXPIRED' });
        throw new ApiError(422, 'انتهت صلاحية جلسة الدفع', PAYMENT_ERROR_CODES.CHECKOUT_EXPIRED);
    }
    if (session.paymentMethod !== 'APP_WALLET') {
        throw new ApiError(422, 'هذه الجلسة ليست لدفع من المحفظة', PAYMENT_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE);
    }

    const amountFils = session.totalDeliveryPriceFils;

    if (!isValidFils(amountFils)) {
        throw new ApiError(422, 'المبلغ غير صالح', PAYMENT_ERROR_CODES.ORDER_NOT_PAYABLE);
    }

    if (amountFils < ORDER_MIN_PAYMENT_FILS) {
        throw new ApiError(
            422,
            `الحد الأدنى لدفع الطلب من المحفظة هو ${filsToEgp(ORDER_MIN_PAYMENT_FILS)} ج.م`,
            PAYMENT_ERROR_CODES.ORDER_NOT_PAYABLE
        );
    }

    const debitReference = `ORDER_PAY_${checkoutSessionId}`;

    // ── Step 2: Atomic session claim (prevents concurrent debits) ───────────
    const lockedSession = await CheckoutSession.findOneAndUpdate(
        { _id: checkoutSessionId, status: 'PENDING' },
        { $set: { status: 'PROCESSING' } },
        { new: true }
    );

    if (!lockedSession) {
        const existingSession = await CheckoutSession.findById(checkoutSessionId).lean();
        if (existingSession?.status === 'COMPLETED') {
            logger.info('[WalletPaymentService] Duplicate wallet order payment (idempotent)', {
                requestId, checkoutSessionId, debitReference,
            });
            return {
                orderId:        existingSession.finalOrderId,
                orderNumericId: existingSession.finalOrderNumericId,
                paymentId:      existingSession.paymentId,
            };
        }

        // Self-healing crash recovery: if session is stuck in PROCESSING but payment & order succeeded
        if (existingSession?.status === 'PROCESSING') {
            const existingPayment = await Payment.findOne({
                checkoutSessionId,
                status: 'PAID',
            });
            if (existingPayment && existingPayment.orderId) {
                await CheckoutSession.findByIdAndUpdate(checkoutSessionId, {
                    status: 'COMPLETED',
                    finalOrderId: existingPayment.orderId,
                    finalOrderNumericId: existingPayment.orderNumericId,
                    paymentId: existingPayment._id,
                    completedAt: new Date(),
                }).catch(() => {});

                return {
                    orderId:        existingPayment.orderId,
                    orderNumericId: existingPayment.orderNumericId,
                    paymentId:      existingPayment._id,
                };
            }
        }

        throw new ApiError(
            409,
            'جلسة الدفع قيد المعالجة حالياً أو تم إكمالها بالفعل',
            PAYMENT_ERROR_CODES.CHECKOUT_ALREADY_COMPLETED
        );
    }

    // ── Step 3: Get wallet and check balance ────────────────────────────────
    const wallet = await getOrCreateWallet(userId);
    if (wallet.balanceFils < amountFils) {
        await CheckoutSession.findByIdAndUpdate(checkoutSessionId, { status: 'PENDING' }).catch(() => {});
        throw new ApiError(
            422,
            `رصيد المحفظة غير كافٍ. المتاح: ${filsToEgp(wallet.balanceFils)} ج.م، المطلوب: ${filsToEgp(amountFils)} ج.م`,
            PAYMENT_ERROR_CODES.WALLET_INSUFFICIENT_BALANCE
        );
    }

    // ── Step 4: Atomic wallet debit ─────────────────────────────────────────
    // Use $inc with $gte condition to prevent overdraft from concurrent requests
    const updatedWallet = await Wallet.findOneAndUpdate(
        {
            _id:         wallet._id,
            balanceFils: { $gte: amountFils }, // Prevent overdraft
        },
        { $inc: { balanceFils: -amountFils } },
        { new: true }
    );

    if (!updatedWallet) {
        // Balance changed between check and update (concurrent request won)
        await CheckoutSession.findByIdAndUpdate(checkoutSessionId, { status: 'PENDING' }).catch(() => {});
        throw new ApiError(
            422,
            'رصيد المحفظة غير كافٍ. حاول مرة أخرى.',
            PAYMENT_ERROR_CODES.WALLET_INSUFFICIENT_BALANCE
        );
    }

    const balanceBefore = updatedWallet.balanceFils + amountFils;
    const balanceAfter  = updatedWallet.balanceFils;

    // Track the embedded transaction as well (backward compatibility)
    updatedWallet.transactions = updatedWallet.transactions || [];
    updatedWallet.transactions.push({
        type:             'debit',
        amountFils,
        balanceAfterFils: balanceAfter,
        description:      `دفع قيمة الطلب من المحفظة`,
        refId:            String(checkoutSessionId),
        performedBy:      'system',
    });
    await updatedWallet.save().catch(() => {});

    // ── Step 5: Create WalletLedger debit entry ─────────────────────────────
    let ledgerEntry;
    try {
        ledgerEntry = await WalletLedger.create({
            walletId:          wallet._id,
            userId:            String(userId),
            type:              'DEBIT',
            source:            'ORDER_PAYMENT',
            amountFils,
            currency:          CURRENCY.EGP,
            balanceBeforeFils: balanceBefore,
            balanceAfterFils:  balanceAfter,
            status:            'COMPLETED',
            checkoutSessionId: session._id,
            reference:         debitReference,
            description:       `Order payment from wallet — ${filsToEgp(amountFils)} EGP`,
            performedBy:       String(userId),
        });
    } catch (err) {
        if (err.code === 11000) {
            // Already exists — concurrent request wrote it first (idempotent)
            logger.info('[WalletPaymentService] Concurrent wallet debit — already written', {
                requestId, debitReference,
            });
        } else {
            // Ledger write failed — compensate by re-crediting wallet
            logger.error('[WalletPaymentService] WalletLedger write failed — reversing debit', {
                requestId, err: err.message,
            });
            await _reverseWalletDebit({ wallet, amountFils, checkoutSessionId, userId, requestId });
            throw new ApiError(500, 'فشل في تسجيل الدفع من المحفظة', 'WALLET_DEBIT_FAILED');
        }
    }

    // ── Step 6: Create Payment record (PAID — no Paymob) ───────────────────
    let paymentDoc;
    try {
        paymentDoc = await Payment.create({
            userId:            String(userId),
            purpose:           'ORDER_PAYMENT',
            paymentMethod:     'APP_WALLET',
            provider:          'app_wallet',
            checkoutSessionId: session._id,
            amountPiastres:    filsToEgpPiastres(amountFils),
            currency:          CURRENCY.EGP,
            status:            'PAID',
            specialReference:  `wallet_pay_${session._id}`,
            paidAt:            new Date(),
            expiresAt:         new Date(),
            metadata:          { walletId: String(wallet._id) },
        });
    } catch (err) {
        logger.error('[WalletPaymentService] Payment record creation failed — reversing', {
            requestId, err: err.message,
        });
        await _reverseWalletDebit({ wallet, amountFils, checkoutSessionId, userId, requestId });
        throw new ApiError(500, 'فشل في تسجيل الدفع', 'PAYMENT_PROVIDER_ERROR');
    }

    // Update ledger with paymentId
    if (ledgerEntry) {
        await WalletLedger.findByIdAndUpdate(ledgerEntry._id, { paymentId: paymentDoc._id }).catch(() => {});
    }

    // ── Step 7: Create final Order from snapshot ────────────────────────────
    let finalOrder;
    try {
        finalOrder = await _createOrderFromSnapshot({
            session,
            paymentId:     paymentDoc._id,
            paymentMethod: 'wallet',
            requestId,
        });
    } catch (err) {
        logger.error('[WalletPaymentService] Order creation failed after wallet debit — reversing', {
            requestId, err: err.message,
        });
        // Mark payment as failed
        await Payment.findByIdAndUpdate(paymentDoc._id, {
            status: 'FAILED',
            failureReason: `Order creation failed: ${err.message}`,
            failedAt: new Date(),
        }).catch(() => {});
        // Reverse wallet debit
        await _reverseWalletDebit({ wallet, amountFils, checkoutSessionId, userId, requestId });
        throw new ApiError(500, 'فشل في إنشاء الطلب', 'ORDER_CREATION_FAILED');
    }

    // ── Step 8: Update Payment with Order reference ─────────────────────────
    await Payment.findByIdAndUpdate(paymentDoc._id, {
        orderId:        finalOrder._id,
        orderNumericId: finalOrder.orderId,
    }).catch(() => {});

    // Update ledger with orderId
    if (ledgerEntry) {
        await WalletLedger.findByIdAndUpdate(ledgerEntry._id, { orderId: finalOrder._id }).catch(() => {});
    }

    // ── Step 9: Mark CheckoutSession as COMPLETED ───────────────────────────
    await CheckoutSession.findByIdAndUpdate(session._id, {
        status:             'COMPLETED',
        finalOrderId:       finalOrder._id,
        finalOrderNumericId: finalOrder.orderId,
        paymentId:          paymentDoc._id,
        paidAt:             new Date(),
        completedAt:        new Date(),
    }).catch(() => {});

    // ── Step 10: Audit events ───────────────────────────────────────────────
    await _recordPaymentEvent({
        paymentId:         paymentDoc._id,
        orderId:           finalOrder._id,
        checkoutSessionId: session._id,
        eventType:         'ORDER_PAYMENT_FROM_WALLET',
        requestId,
        message:           `Wallet debit ${amountFils} fils for order ${finalOrder.orderId}`,
        payloadSummary:    { amountFils, balanceBefore, balanceAfter },
    });

    await _recordPaymentEvent({
        paymentId:         paymentDoc._id,
        orderId:           finalOrder._id,
        checkoutSessionId: session._id,
        eventType:         'ORDER_CREATED_AFTER_PAYMENT',
        requestId,
        message:           `Order #${finalOrder.orderId} created after wallet payment`,
        payloadSummary:    { orderNumericId: finalOrder.orderId },
    });

    logger.info('[WalletPaymentService] ORDER_PAYMENT_FROM_WALLET completed', {
        requestId,
        paymentId:      paymentDoc._id,
        orderId:        finalOrder._id,
        orderNumericId: finalOrder.orderId,
        amountFils,
    });

    return {
        orderId:        finalOrder._id,
        orderNumericId: finalOrder.orderId,
        paymentId:      paymentDoc._id,
    };
}

// ─── 3. Refund to Wallet ──────────────────────────────────────────────────────

/**
 * Credit wallet as a refund when an APP_WALLET order is cancelled.
 *
 * Idempotency: reference = ORDER_REFUND_<orderId>
 *
 * @param {object} params
 * @param {string} params.orderId     - Order._id
 * @param {number} params.amountFils  - Amount to refund (fils)
 * @param {string} params.userId
 * @param {string} params.paymentId   - Payment._id
 * @param {string} params.requestId
 */
async function refundToWallet({ orderId, amountFils, userId, paymentId, requestId, reference: customReference }) {
    if (!isValidFils(amountFils)) {
        throw new Error(`[WalletPaymentService] Invalid refund amount: ${amountFils}`);
    }

    const reference = customReference || (orderId ? `ORDER_REFUND_${orderId}` : `ORDER_RECOVERY_REFUND_${paymentId}`);

    // Idempotency & recovery check
    const existing = await WalletLedger.findOne({ reference });
    if (existing) {
        if (existing.status === 'COMPLETED') {
            logger.info('[WalletPaymentService] Wallet refund already processed (idempotent)', {
                requestId, reference, orderId,
            });
            return;
        }

        if (existing.status === 'PENDING') {
            // Deterministic crash recovery for PENDING refund ledger:
            // Check if wallet balance was already credited
            const wallet = await getOrCreateWallet(userId);
            const alreadyCredited = wallet.transactions && wallet.transactions.some(
                t => t.type === 'credit' && String(t.refId) === String(orderId)
            );

            if (!alreadyCredited) {
                const updated = await Wallet.findOneAndUpdate(
                    { _id: wallet._id },
                    { $inc: { balanceFils: amountFils } },
                    { new: true }
                );
                if (updated) {
                    updated.transactions = updated.transactions || [];
                    updated.transactions.push({
                        type:             'credit',
                        amountFils,
                        balanceAfterFils: updated.balanceFils,
                        description:      'استرداد قيمة الطلب الملغي',
                        refId:            String(orderId),
                        performedBy:      'system',
                    });
                    await updated.save().catch(() => {});
                }
            }

            await WalletLedger.findByIdAndUpdate(existing._id, {
                status: 'COMPLETED',
                balanceBeforeFils: wallet.balanceFils,
                balanceAfterFils:  wallet.balanceFils + (alreadyCredited ? 0 : amountFils),
            }).catch(() => {});

            logger.info('[WalletPaymentService] Recovered PENDING wallet refund ledger', {
                requestId, reference, orderId, alreadyCredited,
            });
            return;
        }
    }

    const wallet = await getOrCreateWallet(userId);

    // ── Step 1: Idempotency claim via WalletLedger unique reference ─────────
    // Claim unique reference FIRST. If a concurrent duplicate arrives, the unique
    // constraint on `reference` rejects it here before balance is ever mutated.
    let ledgerEntry;
    try {
        ledgerEntry = await WalletLedger.create({
            walletId:          wallet._id,
            userId:            String(userId),
            type:              'CREDIT',
            source:            'ORDER_REFUND',
            amountFils,
            currency:          CURRENCY.EGP,
            balanceBeforeFils: wallet.balanceFils,
            balanceAfterFils:  wallet.balanceFils + amountFils,
            status:            'PENDING',
            paymentId:         paymentId ? (mongoose.Types.ObjectId.isValid(paymentId) ? paymentId : null) : null,
            orderId:           orderId ? (mongoose.Types.ObjectId.isValid(orderId) ? orderId : null) : null,
            reference,
            description:       `Refund for cancelled order — ${filsToEgp(amountFils)} EGP`,
            performedBy:       'system',
        });
    } catch (err) {
        if (err.code === 11000) {
            logger.info('[WalletPaymentService] Wallet refund already claimed or processed (idempotent)', {
                requestId, reference, orderId,
            });
            return;
        }
        logger.error('[WalletPaymentService] Wallet refund ledger claim failed', {
            requestId, err: err.message,
        });
        throw err;
    }

    // ── Step 2: Atomic wallet balance credit ────────────────────────────────
    const updatedWallet = await Wallet.findOneAndUpdate(
        { _id: wallet._id },
        { $inc: { balanceFils: amountFils } },
        { new: true }
    );

    if (!updatedWallet) {
        logger.error('[WalletPaymentService] Wallet disappeared during refund', {
            requestId, userId, orderId,
        });
        await WalletLedger.findByIdAndUpdate(ledgerEntry._id, { status: 'FAILED' }).catch(() => {});
        return;
    }

    const balanceAfter  = updatedWallet.balanceFils;
    const balanceBefore = balanceAfter - amountFils;

    // ── Step 3: Complete ledger entry with verified balances ────────────────
    await WalletLedger.findByIdAndUpdate(ledgerEntry._id, {
        status:            'COMPLETED',
        balanceBeforeFils: balanceBefore,
        balanceAfterFils:  balanceAfter,
    }).catch(() => {});

    // Embed in existing wallet transactions
    updatedWallet.transactions = updatedWallet.transactions || [];
    updatedWallet.transactions.push({
        type:             'credit',
        amountFils,
        balanceAfterFils: balanceAfter,
        description:      `استرداد قيمة الطلب الملغي`,
        refId:            String(orderId),
        performedBy:      'system',
    });
    await updatedWallet.save().catch(() => {});

    if (paymentId) {
        await _recordPaymentEvent({
            paymentId,
            orderId,
            eventType:  'WALLET_CREDIT',
            requestId,
            message:    `Wallet refund credit ${amountFils} fils for cancelled order`,
            payloadSummary: { amountFils, balanceBefore, balanceAfter },
        });
    }

    logger.info('[WalletPaymentService] Wallet refund completed', {
        requestId, orderId, amountFils, balanceAfter,
    });

    // Notification
    try {
        const { dispatchWalletNotification: notif } = require('../../middlewares/Wallet');
        notif({
            userId,
            type:             'credit',
            amountFils,
            balanceAfterFils: balanceAfter,
            description:      `استرداد قيمة الطلب الملغي`,
            refId:            String(orderId),
        });
    } catch (_) {}
}

// ─── 4. Validate Top-Up Amount ────────────────────────────────────────────────

/**
 * Validate a wallet top-up request before creating a Paymob intention.
 * Throws ApiError for invalid amounts, limits, etc.
 *
 * @param {object} params
 * @param {number} params.amountFils - Requested top-up in fils
 * @param {string} params.userId
 */
async function validateTopupAmount({ amountFils, userId }) {
    if (!Number.isInteger(amountFils) || amountFils <= 0) {
        throw new ApiError(
            400,
            `مبلغ الشحن غير صالح. يجب أن يكون مبلغاً موجباً بالجنيه المصري.`,
            PAYMENT_ERROR_CODES.WALLET_TOPUP_INVALID_AMOUNT
        );
    }

    if (amountFils < WALLET_MIN_TOPUP_FILS) {
        const minEgp = filsToEgp(WALLET_MIN_TOPUP_FILS);
        throw new ApiError(
            422,
            `الحد الأدنى للشحن هو ${minEgp} ج.م`,
            PAYMENT_ERROR_CODES.WALLET_TOPUP_BELOW_MIN
        );
    }

    if (amountFils > WALLET_MAX_TOPUP_FILS) {
        const maxEgp = filsToEgp(WALLET_MAX_TOPUP_FILS);
        throw new ApiError(
            422,
            `الحد الأقصى للشحن في معاملة واحدة هو ${maxEgp} ج.م`,
            PAYMENT_ERROR_CODES.WALLET_TOPUP_ABOVE_MAX
        );
    }

    // Check current balance + requested amount vs max allowed balance
    const wallet = await getOrCreateWallet(userId);
    if ((wallet.balanceFils + amountFils) > WALLET_MAX_BALANCE_FILS) {
        const maxEgp = filsToEgp(WALLET_MAX_BALANCE_FILS);
        throw new ApiError(
            422,
            `الرصيد بعد الشحن سيتجاوز الحد الأقصى المسموح به (${maxEgp} ج.م)`,
            PAYMENT_ERROR_CODES.WALLET_BALANCE_EXCEEDED
        );
    }

    // Check daily top-up limit
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayTopups = await WalletLedger.aggregate([
        {
            $match: {
                userId: String(userId),
                source: 'PAYMOB_TOPUP',
                type: 'CREDIT',
                status: 'COMPLETED',
                createdAt: { $gte: startOfDay },
            },
        },
        { $group: { _id: null, total: { $sum: '$amountFils' } } },
    ]);
    const todayTotal = todayTopups[0]?.total || 0;
    if (todayTotal + amountFils > WALLET_DAILY_TOPUP_LIMIT_FILS) {
        const maxEgp = filsToEgp(WALLET_DAILY_TOPUP_LIMIT_FILS);
        throw new ApiError(
            422,
            `تم تجاوز الحد اليومي للشحن (${maxEgp} ج.م)`,
            PAYMENT_ERROR_CODES.WALLET_DAILY_LIMIT_EXCEEDED
        );
    }
}

/**
 * Initiate a wallet top-up payment via Paymob.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {number} params.amountFils
 * @param {string} params.requestId
 * @returns {Promise<{ paymentId, status, clientSecret, expiresAt, amountFils, amountEgp }>}
 */
async function createWalletTopupPayment({
    userId,
    amountFils,
    paymentMethod = 'ALL',
    walletPhoneNumber,
    requestId,
}) {
    await validateTopupAmount({ amountFils, userId });

    const { User } = require('../../middlewares/User');
    const user = await User.findById(userId).lean();
    if (!user) {
        throw new ApiError(404, 'المستخدم غير موجود', PAYMENT_ERROR_CODES.PAYMENT_UNAUTHORIZED);
    }

    const wallet = await getOrCreateWallet(userId);
    const amountPiastres = filsToEgpPiastres(amountFils);

    const paymobConfig = require('../config/paymobConfig');

    // Normalize payment method for the Payment document
    const normPm = String(paymentMethod || '').toUpperCase().trim();
    let initialPaymentMethod = 'CARD';
    if (normPm === 'MOBILE_WALLET' || normPm === 'WALLET' || normPm === 'CASH') {
        initialPaymentMethod = 'MOBILE_WALLET';
    }

    const initialIntegrationId = (initialPaymentMethod === 'MOBILE_WALLET' && paymobConfig.walletIntegrationId)
        ? paymobConfig.walletIntegrationId
        : paymobConfig.integrationId;

    const payment = new Payment({
        userId:         String(userId),
        purpose:        'WALLET_TOPUP',
        paymentMethod:  initialPaymentMethod,
        provider:       'paymob',
        walletId:       wallet._id,
        amountPiastres,
        currency:       CURRENCY.EGP,
        integrationId:  initialIntegrationId,
        status:         'PENDING',
    });
    payment.specialReference = `topup_${payment._id}`;
    await payment.save();

    await _recordPaymentEvent({
        paymentId:  payment._id,
        eventType:  'WALLET_TOPUP_CREATED',
        requestId,
        message:    `Wallet top-up initiated: ${amountFils} fils (${amountPiastres} piastres), method: ${initialPaymentMethod}`,
        payloadSummary: { amountFils, amountPiastres, paymentMethod: initialPaymentMethod },
    });

    const paymobService = require('../providers/paymob/paymob.service');
    let intention;
    try {
        intention = await paymobService.createPaymobIntention({
            amountPiastres,
            specialReference: payment.specialReference,
            user,
            paymentMethod: normPm,
            walletPhoneNumber,
            requestId,
        });
    } catch (err) {
        await Payment.findByIdAndUpdate(payment._id, {
            status:        'FAILED',
            failedAt:      new Date(),
            failureReason: 'Paymob intention creation failed',
        });
        await _recordPaymentEvent({
            paymentId: payment._id,
            eventType: 'WALLET_TOPUP_FAILED',
            requestId,
            message:   'Paymob intention creation failed for topup',
        });
        throw err;
    }

    await Payment.findByIdAndUpdate(payment._id, {
        providerIntentionId: intention.providerIntentionId,
        providerOrderId:     intention.providerOrderId,
        expiresAt:           intention.expiresAt,
    });

    return {
        paymentId:     payment._id,
        status:        'PENDING',
        clientSecret:  intention.clientSecret,
        checkoutUrl:   intention.checkoutUrl,
        publicKey:     intention.publicKey || paymobConfig.publicKey,
        expiresAt:     intention.expiresAt,
        amountFils,
        amountEgp:     filsToEgp(amountFils),
        paymentMethod: initialPaymentMethod,
    };
}

// ─── 5. Get Wallet Balance ─────────────────────────────────────────────────────

/**
 * Get wallet balance for a user (creates if not exists).
 * @param {string} userId
 * @returns {Promise<{ balanceFils, balanceEgp, currency }>}
 */
async function getWalletBalance(userId) {
    const wallet = await getOrCreateWallet(userId);
    const egpAmount = filsToEgp(wallet.balanceFils);
    return {
        balance:     egpAmount,
        balanceEgp:  egpAmount,
        balanceFils: wallet.balanceFils,
        currency:    CURRENCY.EGP,
    };
}

// ─── 6. Get Wallet Transaction History ────────────────────────────────────────

/**
 * Paginated wallet ledger history (customer-facing).
 * Only returns entries from WalletLedger (payment-related transactions).
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {number} params.page
 * @param {number} params.limit
 * @returns {Promise<{ transactions, total, page, limit }>}
 */
async function getWalletTransactions({ userId, page = 1, limit = 20 }) {
    const skip = (page - 1) * limit;
    const userIdStr = String(userId);

    // 1. Fetch from WalletLedger and user's Wallet document concurrently
    const [transactions, ledgerTotal, walletDoc] = await Promise.all([
        WalletLedger.find({ userId: userIdStr })
            .sort({ createdAt: -1 })
            .select('-metadata -__v')
            .lean(),
        WalletLedger.countDocuments({ userId: userIdStr }),
        Wallet.findOne({
            $or: [
                { userId: userIdStr },
                ...(mongoose.Types.ObjectId.isValid(userId) ? [{ userId: new mongoose.Types.ObjectId(userId) }] : [])
            ]
        }).select('transactions').lean(),
    ]);

    // 2. Build set of existing references/IDs to avoid any duplicate transaction
    const knownRefs = new Set();
    for (const tx of transactions) {
        if (tx.reference) knownRefs.add(String(tx.reference));
        if (tx.paymentId) knownRefs.add(String(tx.paymentId));
        if (tx.orderId) knownRefs.add(String(tx.orderId));
    }

    // 3. Map any transactions from wallet.transactions (e.g. representative earnings/rewards/commission)
    const extraTxs = [];
    if (walletDoc && Array.isArray(walletDoc.transactions)) {
        for (const tx of walletDoc.transactions) {
            const ref = tx.refId ? String(tx.refId) : null;
            if (ref && knownRefs.has(ref)) continue;

            const txType = (tx.type || '').toLowerCase();
            const isCredit = txType === 'credit' || txType.includes('reward');
            const type = isCredit ? 'CREDIT' : 'DEBIT';

            extraTxs.push({
                _id: tx._id,
                type,
                source: txType.includes('reward') ? 'REWARD' : 'OTHER',
                amountFils: tx.amountFils,
                amountEgp: filsToEgp(tx.amountFils),
                currency: CURRENCY.EGP,
                balanceAfterFils: tx.balanceAfterFils || 0,
                balanceAfterEgp: filsToEgp(tx.balanceAfterFils || 0),
                status: 'COMPLETED',
                description: tx.description || (isCredit ? 'إضافة رصيد' : 'خصم رصيد'),
                reference: ref,
                createdAt: tx.createdAt || new Date(),
                orderId: ref,
                paymentId: null,
            });
        }
    }

    // 4. Combine and sort all transactions by createdAt descending
    const allMapped = [
        ...transactions.map((tx) => ({
            _id:              tx._id,
            type:             tx.type,
            source:           tx.source,
            amountFils:       tx.amountFils,
            amountEgp:        filsToEgp(tx.amountFils),
            currency:         tx.currency,
            balanceAfterFils: tx.balanceAfterFils,
            balanceAfterEgp:  filsToEgp(tx.balanceAfterFils),
            status:           tx.status,
            description:      tx.description,
            reference:        tx.reference,
            createdAt:        tx.createdAt,
            orderId:          tx.orderId,
            paymentId:        tx.paymentId,
        })),
        ...extraTxs,
    ];

    allMapped.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = allMapped.length;
    const paginated = allMapped.slice(skip, skip + limit);

    return { transactions: paginated, total, page, limit };
}

// ─── Private Helpers ──────────────────────────────────────────────────────────

/**
 * Compensating transaction: reverse a wallet debit if order creation fails.
 */
async function _reverseWalletDebit({ wallet, amountFils, checkoutSessionId, userId, requestId }) {
    const reverseRef = `REVERSAL_ORDER_PAY_${checkoutSessionId}`;
    try {
        const updatedWallet = await Wallet.findOneAndUpdate(
            { _id: wallet._id },
            { $inc: { balanceFils: amountFils } },
            { new: true }
        );

        if (updatedWallet) {
            await WalletLedger.create({
                walletId:          wallet._id,
                userId:            String(userId),
                type:              'CREDIT',
                source:            'OTHER',
                amountFils,
                currency:          CURRENCY.EGP,
                balanceBeforeFils: updatedWallet.balanceFils - amountFils,
                balanceAfterFils:  updatedWallet.balanceFils,
                status:            'COMPLETED',
                checkoutSessionId,
                reference:         reverseRef,
                description:       'Reversal of failed order payment',
                performedBy:       'system',
            }).catch(() => {});

            logger.info('[WalletPaymentService] Wallet debit reversed', {
                requestId, amountFils, checkoutSessionId,
            });
        }
        await CheckoutSession.findByIdAndUpdate(checkoutSessionId, { status: 'PENDING' }).catch(() => {});
    } catch (err) {
        logger.error('[WalletPaymentService] CRITICAL: Failed to reverse wallet debit', {
            requestId, amountFils, checkoutSessionId, err: err.message,
        });
    }
}

/**
 * Create the final Order from a CheckoutSession snapshot.
 * This is the moment the Order actually comes into existence.
 */
async function _createOrderFromSnapshot({ session, paymentId, paymentMethod, requestId, mongoSession }) {
    const snapshot = session.orderSnapshot;
    if (!snapshot) {
        throw new Error('CheckoutSession.orderSnapshot is missing');
    }

    const { Order: OrderModel, getNextGlobalOrderId: getOrderId, getNextTaskId: getTaskId } =
        require('../../middlewares/Order');

    // Assign task IDs
    const tasks = [];
    if (Array.isArray(snapshot.tasks)) {
        for (const task of snapshot.tasks) {
            const taskId = await getTaskId();
            tasks.push({ ...task, taskId });
        }
    }

    const orderId = await getOrderId();

    const order = new OrderModel({
        orderId,
        clientId:                  String(session.userId),
        originalDeliveryPrice:     session.originalDeliveryPriceFils || null,
        totalDeliveryPrice:        session.totalDeliveryPriceFils,
        discountAmount:            session.discountAmountFils || 0,
        discountCode:              session.discountCode || null,
        discountType:              session.discountType || null,
        discountPercentage:        session.discountPercentage || null,
        totalPrice:                snapshot.totalPrice || session.totalDeliveryPriceFils,
        totalDistanceKm:           snapshot.totalDistanceKm || 0,
        vehicleTypeId:             session.vehicleTypeId || snapshot.vehicleTypeId || null,
        vehicleName:               snapshot.vehicleName || null,
        vehicleTypeName:           snapshot.vehicleTypeName || null,
        is_ladies_only:            snapshot.is_ladies_only || false,
        orderType:                 snapshot.orderType || null,
        orderCategory:             session.orderCategory || 'delivery',
        governorate:               session.governorate || null,
        paymentMethod:             paymentMethod || 'wallet',
        paymentStatus:             (paymentMethod === 'cash') ? 'unpaid' : 'paid',
        representativeWillPay:     snapshot.representativeWillPay || false,
        representativePaymentAmount: snapshot.representativePaymentAmount || 0,
        purchaseDetails:           snapshot.purchaseDetails || '',
        tasks,
        status:                    'waiting',
        allLocationsInOrder:       snapshot.allLocationsInOrder || [],
        pricingVersion:            snapshot.pricingVersion || 1,
        routeStatus:               snapshot.routeStatus || 'PROCESSING',
        routeSource:               snapshot.routeSource || 'GOOGLE',
        routeSnapshot:             snapshot.routeSnapshot || {},
    });

    await order.save(mongoSession ? { session: mongoSession } : undefined);

    logger.info('[WalletPaymentService] Final order created from session snapshot', {
        requestId,
        orderMongoId: order._id,
        orderNumericId: order.orderId,
        checkoutSessionId: session._id,
        paymentId,
    });

    return order;
}

/**
 * Create a PaymentEvent audit record.
 */
async function _recordPaymentEvent({ paymentId, orderId, checkoutSessionId, eventType, requestId, payloadSummary, message }) {
    try {
        await PaymentEvent.create({
            paymentId,
            orderId:           orderId || null,
            checkoutSessionId: checkoutSessionId || null,
            eventType,
            provider:          'system',
            requestId:         requestId || null,
            payloadSummary:    payloadSummary || null,
            message:           message || null,
        });
    } catch (err) {
        logger.error('[WalletPaymentService] Failed to create PaymentEvent', {
            eventType, paymentId, message: err.message,
        });
    }
}

module.exports = {
    processWalletTopup,
    payOrderFromWallet,
    refundToWallet,
    validateTopupAmount,
    getWalletBalance,
    getWalletTransactions,
    createWalletTopupPayment,
    _createOrderFromSnapshot,
};

