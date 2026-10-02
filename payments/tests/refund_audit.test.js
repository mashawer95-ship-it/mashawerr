/**
 * payments/tests/refund_audit.test.js
 * Verification test suite for all 8 mandatory Refund Audit requirements:
 *
 *  Test 1: 20 concurrent Wallet Refund requests for the same payment.
 *          Expected: 1 financial credit, 19 idempotent/rejected.
 *  Test 2: 20 concurrent Visa Refund requests for the same payment.
 *          Expected: 1 refund operation, 19 rejected with 422 (no duplicate refund).
 *  Test 3: Wallet Refund + Visa Refund simultaneously on the same payment.
 *          Expected: Only one valid refund destination, zero double refund.
 *  Test 4: Refund + duplicate webhook.
 *          Expected: No duplicate financial mutation.
 *  Test 5: Refund request + network timeout.
 *          Expected: Unknown result is not treated as failed/successful blindly (504 UNCERTAIN, no wallet fallback).
 *  Test 6: Refund amount > paid amount.
 *          Expected: Rejected with 422, no financial mutation.
 *  Test 7: Customer A attempts refund on Customer B's order.
 *          Expected: Rejected with 403/Forbidden, no financial mutation.
 *  Test 8: Already refunded payment retry.
 *          Expected: Idempotent response / rejected with 422, no second financial mutation.
 */

'use strict';

process.env.PAYMOB_SECRET_KEY     = 'test_secret_key';
process.env.PAYMOB_PUBLIC_KEY     = 'test_public_key';
process.env.PAYMOB_HMAC_SECRET    = 'test_hmac_secret_32_bytes_exactly!';
process.env.PAYMOB_INTEGRATION_ID = '12345';
process.env.PAYMOB_CARD_INTEGRATION_ID = '12345';
process.env.NODE_ENV              = 'test';

require('dotenv').config();
const assert = require('assert');
const mongoose = require('mongoose');

// Models
const { Order, getNextGlobalOrderId } = require('../../middlewares/Order');
const { User } = require('../../middlewares/User');
const { Wallet } = require('../../middlewares/Wallet');
const { WalletLedger } = require('../../middlewares/WalletLedger');
const { Payment } = require('../../middlewares/Payment');

// Services
const paymentService = require('../services/paymentService');
const { refundToWallet } = require('../services/walletPaymentService');
const paymobService = require('../providers/paymob/paymob.service');
const { piastresToFils } = require('../utils/money');

let passedCount = 0;
let failedCount = 0;

async function runScenario(scenarioId, title, testFn) {
    console.log(`\n==================================================`);
    console.log(`[TEST ${scenarioId}] ${title}`);
    console.log(`==================================================`);
    try {
        const details = await testFn();
        passedCount++;
        console.log(`>>> RESULT: PASS`, details ? JSON.stringify(details) : '');
    } catch (err) {
        failedCount++;
        console.error(`>>> RESULT: FAIL - ${err.message}`);
        if (process.env.VERBOSE) console.error(err.stack);
    }
}

async function cleanupTestData(tag) {
    try {
        await User.deleteMany({ email: new RegExp(tag, 'i') });
        await Order.deleteMany({ cancellationReason: new RegExp(tag, 'i') });
        await Wallet.deleteMany({ userId: new RegExp(tag, 'i') });
        await WalletLedger.deleteMany({ userId: new RegExp(tag, 'i') });
        await Payment.deleteMany({ userId: new RegExp(tag, 'i') });
    } catch (_) {}
}

async function main() {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('Connected to MongoDB for Refund Audit Test Suite\n');

    const runTag = `audit_test_${Date.now()}`;

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST 1: 20 concurrent Wallet Refund for the same payment
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario(1, '20 concurrent Wallet Refund requests for the same payment', async () => {
        const userId = `user_t1_${runTag}`;
        await Wallet.create({ userId, balanceFils: 0, transactions: [] });

        const orderIdNum = await getNextGlobalOrderId();
        const order = await Order.create({
            orderId: orderIdNum,
            clientId: userId,
            status: 'accepted',
            totalDeliveryPrice: 5000,
            paymentStatus: 'paid',
            cancellationReason: runTag,
        });

        const payment = await Payment.create({
            userId,
            orderId: order._id,
            orderNumericId: order.orderId,
            provider: 'app_wallet',
            paymentMethod: 'APP_WALLET',
            amountPiastres: 500, // 5 EGP = 5000 fils
            refundedAmountPiastres: 0,
            status: 'PAID',
        });

        // Fire 20 concurrent refund requests
        const results = await Promise.allSettled(
            Array.from({ length: 20 }, (_, i) =>
                paymentService.refundPayment({
                    paymentId: payment._id,
                    amountPiastres: 500,
                    requestedBy: userId,
                    requestId: `t1_req_${i}`,
                    refundPreference: 'APP_WALLET',
                })
            )
        );

        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const rejected = results.filter(r => r.status === 'rejected').length;

        // Verify wallet balance
        const updatedWallet = await Wallet.findOne({ userId });
        const ledgers = await WalletLedger.find({ userId, type: 'CREDIT' });

        assert.strictEqual(succeeded, 1, `Exactly 1 refund must succeed, got ${succeeded}`);
        assert.strictEqual(rejected, 19, `19 requests must be rejected, got ${rejected}`);
        assert.strictEqual(updatedWallet.balanceFils, 5000, `Wallet balance must be exactly 5000 fils, got ${updatedWallet.balanceFils}`);
        assert.strictEqual(ledgers.length, 1, `Exactly 1 WalletLedger credit entry must exist, got ${ledgers.length}`);

        return { succeeded, rejected, finalBalanceFils: updatedWallet.balanceFils };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST 2: 20 concurrent Visa Refund for the same payment
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario(2, '20 concurrent Visa Refund requests for the same payment', async () => {
        const userId = `user_t2_${runTag}`;
        const orderIdNum = await getNextGlobalOrderId();
        const order = await Order.create({
            orderId: orderIdNum,
            clientId: userId,
            status: 'accepted',
            totalDeliveryPrice: 10000,
            paymentStatus: 'paid',
            cancellationReason: runTag,
        });

        const payment = await Payment.create({
            userId,
            orderId: order._id,
            orderNumericId: order.orderId,
            provider: 'paymob',
            paymentMethod: 'CARD',
            providerTransactionId: `txn_t2_${Date.now()}`,
            amountPiastres: 1000, // 10 EGP
            refundedAmountPiastres: 0,
            status: 'PAID',
        });

        let paymobRefundCalls = 0;
        const origRequestRefund = paymobService.requestRefund;
        paymobService.requestRefund = async () => {
            paymobRefundCalls++;
            return { id: 12345, success: true };
        };

        let results;
        try {
            results = await Promise.allSettled(
                Array.from({ length: 20 }, (_, i) =>
                    paymentService.refundPayment({
                        paymentId: payment._id,
                        amountPiastres: 1000,
                        requestedBy: userId,
                        requestId: `t2_req_${i}`,
                        refundPreference: 'ORIGINAL_PAYMENT',
                    })
                )
            );
        } finally {
            paymobService.requestRefund = origRequestRefund;
        }

        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const rejected = results.filter(r => r.status === 'rejected').length;

        const updatedPayment = await Payment.findById(payment._id);

        assert.strictEqual(succeeded, 1, `Exactly 1 Visa refund must succeed, got ${succeeded}`);
        assert.strictEqual(rejected, 19, `19 Visa refund attempts must be rejected with 422, got ${rejected}`);
        assert.strictEqual(paymobRefundCalls, 1, `Paymob API must be called exactly once, got ${paymobRefundCalls}`);
        assert.strictEqual(updatedPayment.refundedAmountPiastres, 1000, 'Refunded amount must equal 1000 piastres');
        assert.strictEqual(updatedPayment.status, 'REFUNDED', 'Payment status must be REFUNDED');

        return { succeeded, rejected, paymobRefundCalls };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST 3: Wallet Refund + Visa Refund simultaneously on the same payment
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario(3, 'Wallet Refund + Visa Refund dispatched simultaneously on same payment', async () => {
        const userId = `user_t3_${runTag}`;
        await Wallet.create({ userId, balanceFils: 0, transactions: [] });

        const orderIdNum = await getNextGlobalOrderId();
        const order = await Order.create({
            orderId: orderIdNum,
            clientId: userId,
            status: 'accepted',
            totalDeliveryPrice: 7000,
            paymentStatus: 'paid',
            cancellationReason: runTag,
        });

        const payment = await Payment.create({
            userId,
            orderId: order._id,
            orderNumericId: order.orderId,
            provider: 'paymob',
            paymentMethod: 'CARD',
            providerTransactionId: `txn_t3_${Date.now()}`,
            amountPiastres: 700, // 7 EGP
            refundedAmountPiastres: 0,
            status: 'PAID',
        });

        let paymobRefundCalls = 0;
        const origRequestRefund = paymobService.requestRefund;
        paymobService.requestRefund = async () => {
            paymobRefundCalls++;
            return { id: 12345, success: true };
        };

        let results;
        try {
            results = await Promise.allSettled([
                paymentService.refundPayment({
                    paymentId: payment._id,
                    amountPiastres: 700,
                    requestedBy: userId,
                    requestId: 't3_wallet',
                    refundPreference: 'APP_WALLET',
                }),
                paymentService.refundPayment({
                    paymentId: payment._id,
                    amountPiastres: 700,
                    requestedBy: userId,
                    requestId: 't3_visa',
                    refundPreference: 'ORIGINAL_PAYMENT',
                }),
            ]);
        } finally {
            paymobService.requestRefund = origRequestRefund;
        }

        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const rejected = results.filter(r => r.status === 'rejected').length;

        const updatedWallet = await Wallet.findOne({ userId });
        const updatedPayment = await Payment.findById(payment._id);

        assert.strictEqual(succeeded, 1, `Exactly one destination must succeed, got ${succeeded}`);
        assert.strictEqual(rejected, 1, `The competing destination must be rejected, got ${rejected}`);
        assert.strictEqual(updatedPayment.refundedAmountPiastres, 700, 'Total refunded must never exceed 700 piastres');

        // Check mutual exclusivity: either wallet credited OR card called, NEVER both!
        const walletCredited = updatedWallet.balanceFils === 7000;
        const cardCalled = paymobRefundCalls === 1;

        assert.strictEqual(walletCredited !== cardCalled, true, 'Mutual exclusion violated: both or neither occurred');

        return {
            winner: walletCredited ? 'APP_WALLET' : 'ORIGINAL_PAYMENT',
            walletBalanceFils: updatedWallet.balanceFils,
            paymobRefundCalls,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST 4: Refund already executed + duplicate webhook arrives
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario(4, 'Refund already executed + duplicate webhook arrives (no status reversal)', async () => {
        const userId = `user_t4_${runTag}`;
        const orderIdNum = await getNextGlobalOrderId();
        const order = await Order.create({
            orderId: orderIdNum,
            clientId: userId,
            status: 'cancelled',
            totalDeliveryPrice: 8000,
            paymentStatus: 'refunded',
            cancellationReason: runTag,
        });

        const txnId = `txn_t4_${Date.now()}`;
        const specialRef = `topup_${Date.now()}`;
        const payment = await Payment.create({
            userId,
            orderId: order._id,
            orderNumericId: order.orderId,
            provider: 'paymob',
            paymentMethod: 'CARD',
            providerTransactionId: txnId,
            specialReference: specialRef,
            amountPiastres: 800,
            refundedAmountPiastres: 800,
            status: 'REFUNDED',
            refundedAt: new Date(),
        });

        // Simulate incoming webhook for the already processed/refunded transaction
        const mockTransaction = {
            id: txnId,
            success: true,
            pending: false,
            amount_cents: 800,
            currency: 'EGP',
            integration_id: 12345,
            special_reference: specialRef,
        };

        await paymentService.processWebhookTransaction({
            transaction: mockTransaction,
            requestId: 't4_webhook_dup',
        });

        const refreshedPayment = await Payment.findById(payment._id);
        assert.strictEqual(refreshedPayment.status, 'REFUNDED', 'Duplicate webhook must not change status from REFUNDED to PAID');
        assert.strictEqual(refreshedPayment.refundedAmountPiastres, 800, 'Refunded amount must remain untouched');

        return { finalStatus: refreshedPayment.status };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST 5: Refund request + network timeout (uncertain state)
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario(5, 'Refund request + network timeout leaves status UNCERTAIN without wallet fallback', async () => {
        const userId = `user_t5_${runTag}`;
        await Wallet.create({ userId, balanceFils: 0, transactions: [] });

        const orderIdNum = await getNextGlobalOrderId();
        const order = await Order.create({
            orderId: orderIdNum,
            clientId: userId,
            status: 'accepted',
            totalDeliveryPrice: 9000,
            paymentStatus: 'paid',
            cancellationReason: runTag,
        });

        const payment = await Payment.create({
            userId,
            orderId: order._id,
            orderNumericId: order.orderId,
            provider: 'paymob',
            paymentMethod: 'CARD',
            providerTransactionId: `txn_t5_${Date.now()}`,
            amountPiastres: 900,
            refundedAmountPiastres: 0,
            status: 'PAID',
        });

        const origRequestRefund = paymobService.requestRefund;
        paymobService.requestRefund = async () => {
            const timeoutErr = new Error('Gateway timed out after 30000ms');
            timeoutErr.code = 'ETIMEDOUT';
            throw timeoutErr;
        };

        let threw504 = false;
        try {
            await paymentService.refundPayment({
                paymentId: payment._id,
                amountPiastres: 900,
                requestedBy: userId,
                requestId: 't5_timeout',
                refundPreference: 'ORIGINAL_PAYMENT',
            });
        } catch (err) {
            threw504 = err.statusCode === 504 || err.errorCode === 'REFUND_STATUS_UNCERTAIN';
        } finally {
            paymobService.requestRefund = origRequestRefund;
        }

        assert.strictEqual(threw504, true, 'Indeterminate gateway error must throw 504 REFUND_STATUS_UNCERTAIN');

        const updatedWallet = await Wallet.findOne({ userId });
        assert.strictEqual(updatedWallet.balanceFils, 0, 'Wallet fallback MUST be blocked during uncertain timeout');

        const updatedPayment = await Payment.findById(payment._id);
        assert.strictEqual(updatedPayment.metadata?.refundStatus, 'UNCERTAIN', 'Payment metadata must record UNCERTAIN status');

        return { threw504, walletBalance: updatedWallet.balanceFils, refundStatus: updatedPayment.metadata?.refundStatus };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST 6: Refund amount > paid amount
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario(6, 'Refund amount > paid amount is rejected without financial mutation', async () => {
        const userId = `user_t6_${runTag}`;
        const payment = await Payment.create({
            userId,
            provider: 'app_wallet',
            paymentMethod: 'APP_WALLET',
            amountPiastres: 300,
            refundedAmountPiastres: 0,
            status: 'PAID',
        });

        let rejected = false;
        try {
            await paymentService.refundPayment({
                paymentId: payment._id,
                amountPiastres: 999999, // Way more than 300
                requestedBy: userId,
                requestId: 't6_exceed',
            });
        } catch (err) {
            rejected = err.statusCode === 422 || err.errorCode === 'REFUND_EXCEEDS_PAID';
        }

        assert.strictEqual(rejected, true, 'Refund exceeding paid amount must be rejected with 422');

        const refreshed = await Payment.findById(payment._id);
        assert.strictEqual(refreshed.refundedAmountPiastres, 0, 'Refunded amount must remain 0');

        return { rejected, refundedAmountPiastres: refreshed.refundedAmountPiastres };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST 7: Customer A attempts refund on Customer B's order
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario(7, 'Customer A attempts refund/cancel on Customer B order (IDOR rejected)', async () => {
        const userA = `user_t7_a_${runTag}`;
        const userB = `user_t7_b_${runTag}`;

        const orderIdNum = await getNextGlobalOrderId();
        const orderB = await Order.create({
            orderId: orderIdNum,
            clientId: userB, // Belongs to User B
            status: 'waiting',
            totalDeliveryPrice: 5000,
            paymentStatus: 'paid',
            cancellationReason: runTag,
        });

        // Simulate cancel request from User A
        const req = {
            params: { id: orderB.orderId },
            body: { reason: 'Attacker trying to cancel victim order', refundPreference: 'APP_WALLET' },
            user: { id: userA, isAdmin: false },
        };

        let responseStatusCode = null;
        let responseJson = null;
        const res = {
            status: (code) => {
                responseStatusCode = code;
                return {
                    json: (data) => { responseJson = data; },
                };
            },
        };

        const { cancelOrder } = require('../../Controllers/orderController');
        await cancelOrder(req, res);

        assert.strictEqual([403, 404].includes(responseStatusCode), true, `IDOR cancellation must return 403 or 404, got ${responseStatusCode}`);

        const orderAfter = await Order.findById(orderB._id);
        assert.strictEqual(orderAfter.status, 'waiting', 'Victim order status must not be modified');

        return { responseStatusCode };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST 8: Already refunded payment retry
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario(8, 'Already refunded payment retry is rejected without second mutation', async () => {
        const userId = `user_t8_${runTag}`;
        const payment = await Payment.create({
            userId,
            provider: 'app_wallet',
            paymentMethod: 'APP_WALLET',
            amountPiastres: 400,
            refundedAmountPiastres: 400, // Fully refunded
            status: 'REFUNDED',
            refundedAt: new Date(),
        });

        let rejected = false;
        try {
            await paymentService.refundPayment({
                paymentId: payment._id,
                amountPiastres: 400,
                requestedBy: userId,
                requestId: 't8_already_refunded',
            });
        } catch (err) {
            rejected = err.statusCode === 422;
        }

        assert.strictEqual(rejected, true, 'Attempting to refund an already refunded payment must be rejected with 422');

        const refreshed = await Payment.findById(payment._id);
        assert.strictEqual(refreshed.refundedAmountPiastres, 400, 'Refunded amount must remain 400');
        assert.strictEqual(refreshed.status, 'REFUNDED', 'Status must remain REFUNDED');

        return { rejected };
    });

    await cleanupTestData(runTag);

    console.log(`\n═══════════════════════════════════════════════════════════════════`);
    console.log(`MANDATORY REFUND AUDIT SUITE COMPLETE`);
    console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);
    console.log(`═══════════════════════════════════════════════════════════════════\n`);

    await mongoose.disconnect();
    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
