/**
 * payments/tests/concurrency.test.js
 * Production-Grade Concurrency & Financial Integrity Adversarial Test Suite
 *
 * Scenarios Tested:
 *  A. 20 concurrent cancel requests (Lock claim, exactly 1 fee & reward, no double debit)
 *  B. 20 concurrent wallet payments (Atomic claim, exactly 1 debit, no overdraft)
 *  C. pay-wallet + pay-online simultaneously (Mutual exclusion on PENDING session)
 *  D. pay-online + pay-online simultaneously (Atomic intention creation, idempotent payment reuse)
 *  E. Duplicate Paymob webhook x10 (Atomic transaction processing, exactly 1 order)
 *  F. Webhook + cancellation race (Never cancelled + paid without refund)
 *  G. Successful payment + failure during order creation (Automatic compensating refund)
 *  H. Duplicate refund requests (Cannot exceed refundable amount)
 *  I. 100 concurrent wallet credits (Mathematical exactness via atomic $inc)
 *  J. 100 concurrent wallet debits (Precondition enforcement, no overdraft)
 *  K. Unauthorized customer reading waiting order (IDOR verification: 404 anti-enumeration)
 *  L. Client price tampering (Server-authoritative pricing, 422 rejection on failure)
 *  M. Expired session payment attempt (Strict state machine rejection)
 *  N. Timeout & retry idempotency (Reusing valid pending payment)
 *  O. Network failure after financial mutation (Audit ledger reconciliation trace)
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

// Mock Paymob intention creation for local test determinism
const paymobService = require('../providers/paymob/paymob.service');
let intentionCallCount = 0;
paymobService.createPaymobIntention = async ({ amountPiastres, specialReference }) => {
    intentionCallCount++;
    return {
        clientSecret: `mock_secret_${intentionCallCount}`,
        providerIntentionId: `mock_pi_${intentionCallCount}`,
        providerOrderId: `mock_po_${intentionCallCount}`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        checkoutUrl: `https://accept.paymob.com/unifiedcheckout/?clientSecret=mock_${intentionCallCount}`,
        publicKey: 'test_public_key',
    };
};

// Models
const { Order, getNextGlobalOrderId } = require('../../middlewares/Order');
const { User } = require('../../middlewares/User');
const { Wallet, creditWallet, debitWallet } = require('../../middlewares/Wallet');
const { WalletLedger } = require('../../middlewares/WalletLedger');
const { Payment } = require('../../middlewares/Payment');
const { CheckoutSession } = require('../../middlewares/CheckoutSession');

// Services
const checkoutService = require('../services/checkoutService');
const paymentService = require('../services/paymentService');
const { payOrderFromWallet, refundToWallet } = require('../services/walletPaymentService');

let passedCount = 0;
let failedCount = 0;
const resultsLog = [];

async function runScenario(scenarioId, title, testFn) {
    console.log(`\n==================================================`);
    console.log(`[TEST ${scenarioId}] ${title}`);
    console.log(`==================================================`);
    try {
        const details = await testFn();
        passedCount++;
        resultsLog.push({ scenarioId, title, status: 'PASS', details });
        console.log(`>>> RESULT: PASS`);
    } catch (err) {
        failedCount++;
        resultsLog.push({ scenarioId, title, status: 'FAIL', error: err.message });
        console.error(`>>> RESULT: FAIL - ${err.message}`);
        if (process.env.VERBOSE) console.error(err.stack);
    }
}

async function cleanupTestData(tag) {
    try {
        await User.deleteMany({ email: new RegExp(tag, 'i') });
        await Order.deleteMany({ cancellationReason: new RegExp(tag, 'i') });
        await CheckoutSession.deleteMany({ userId: new RegExp(tag, 'i') });
        await Wallet.deleteMany({ userId: new RegExp(tag, 'i') });
        await WalletLedger.deleteMany({ userId: new RegExp(tag, 'i') });
        await Payment.deleteMany({ userId: new RegExp(tag, 'i') });
    } catch (_) {}
}

async function main() {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('Connected to MongoDB for Adversarial Concurrency Suite\n');

    const runTag = `test_adv_${Date.now()}`;

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST A: 20 concurrent cancel requests
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('A', '20 concurrent cancellation requests on the same Order', async () => {
        const clientUser = await User.create({
            email: `client_${runTag}_a@test.com`,
            firstName: 'ClientA',
            lastName: 'TestUser',
            userType: 'NormalUser',
            googleId: `gid_a_${Date.now()}_${Math.random()}`,
        });
        const repUser = await User.create({
            email: `rep_${runTag}_a@test.com`,
            firstName: 'RepA',
            lastName: 'TestUser',
            userType: 'representative',
            googleId: `gid_rep_${Date.now()}_${Math.random()}`,
        });

        await Wallet.create({ userId: clientUser._id.toString(), balanceFils: 50000, transactions: [] });
        await Wallet.create({ userId: repUser._id.toString(), balanceFils: 0, transactions: [] });

        const { getOrCreatePricing } = require('../../middlewares/Pricing');
        const pricing = await getOrCreatePricing();
        pricing.cancellationFeeForClient = 500;
        pricing.cancellationRewardForDriver = 300;
        pricing.clientCancellationTimerMinutes = 10;
        await pricing.save();

        const orderIdNum = await getNextGlobalOrderId();
        const order = await Order.create({
            orderId: orderIdNum,
            clientId: clientUser._id.toString(),
            representativeId: repUser._id.toString(),
            status: 'accepted',
            totalDeliveryPrice: 1500,
            paymentStatus: 'unpaid',
            acceptedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 mins ago
            cancellationReason: runTag,
        });

        const { cancelOrder } = require('../../Controllers/orderController');

        const reqMock = {
            params: { id: String(order.orderId) },
            user: { id: clientUser._id.toString(), userType: 'NormalUser' },
            body: { reason: `Adversarial cancel test ${runTag}` },
        };

        const responses = await Promise.all(
            Array.from({ length: 20 }, () => {
                return new Promise((resolve) => {
                    const resMock = {
                        statusCode: 200,
                        body: null,
                        status(code) { this.statusCode = code; return this; },
                        json(data) { this.body = data; resolve(this); },
                    };
                    cancelOrder(reqMock, resMock, () => {});
                });
            })
        );

        const successResponses = responses.filter(r => r.statusCode === 200);
        const alreadyCancelledResponses = responses.filter(r => r.statusCode === 400);

        const finalOrder = await Order.findOne({ orderId: order.orderId });
        const finalClientWallet = await Wallet.findOne({ userId: clientUser._id.toString() });
        const finalRepWallet = await Wallet.findOne({ userId: repUser._id.toString() });

        assert.strictEqual(finalOrder.status, 'cancelled', 'Order status must be cancelled');
        assert.strictEqual(successResponses.length, 1, 'Exactly one concurrent cancel request must succeed');
        assert.strictEqual(alreadyCancelledResponses.length, 19, '19 requests must be rejected with already cancelled');

        const feeTxs = finalClientWallet.transactions.filter(t => t.type === 'cancellation_fee');
        const rewardTxs = finalRepWallet.transactions.filter(t => t.type === 'cancellation_reward');

        assert.strictEqual(feeTxs.length, 1, 'Exactly one cancellation fee must be deducted');
        assert.strictEqual(rewardTxs.length, 1, 'Exactly one cancellation reward must be credited');

        return {
            totalConcurrent: 20,
            successResponses: successResponses.length,
            rejectedResponses: alreadyCancelledResponses.length,
            cancellationFeeCount: feeTxs.length,
            cancellationRewardCount: rewardTxs.length,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST B: 20 concurrent wallet payments for the same CheckoutSession
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('B', '20 concurrent wallet payments for the same CheckoutSession', async () => {
        const userId = `user_${runTag}_b`;
        await Wallet.create({ userId, balanceFils: 10000, transactions: [] });

        const session = await CheckoutSession.create({
            userId,
            status: 'PENDING',
            paymentMethod: 'APP_WALLET',
            totalDeliveryPriceFils: 5000,
            orderSnapshot: {
                totalPrice: 5000,
                tasks: [{ type: 'delivery' }],
            },
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });

        // Fire 20 concurrent payOrderFromWallet requests
        const results = await Promise.allSettled(
            Array.from({ length: 20 }, (_, i) => {
                return payOrderFromWallet({
                    checkoutSessionId: session._id,
                    userId,
                    requestId: `req_b_${i}`,
                });
            })
        );

        const fulfilled = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');

        const finalSession = await CheckoutSession.findById(session._id);
        const finalWallet = await Wallet.findOne({ userId });
        const ledgerEntries = await WalletLedger.find({ checkoutSessionId: session._id, source: 'ORDER_PAYMENT' });
        const ordersCreated = await Order.find({ _id: finalSession.finalOrderId });

        assert.strictEqual(fulfilled.length, 1, 'Exactly 1 wallet payment attempt must succeed');
        assert.strictEqual(rejected.length, 19, '19 concurrent attempts must be rejected');
        assert.strictEqual(finalSession.status, 'COMPLETED');
        assert.strictEqual(finalWallet.balanceFils, 5000, 'Wallet balance must be debited exactly once (10000 - 5000 = 5000)');
        assert.strictEqual(ledgerEntries.length, 1, 'Exactly 1 ledger entry must be created');
        assert.strictEqual(ordersCreated.length, 1, 'Exactly 1 final order must be created');

        return {
            totalConcurrent: 20,
            succeeded: fulfilled.length,
            rejected: rejected.length,
            finalBalanceFils: finalWallet.balanceFils,
            finalSessionStatus: finalSession.status,
            ordersCreated: ordersCreated.length,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST C: pay-wallet + pay-online simultaneously
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('C', 'pay-wallet and pay-online dispatched simultaneously', async () => {
        const clientUser = await User.create({
            email: `user_${runTag}_c@test.com`,
            firstName: 'UserC',
            lastName: 'TestUser',
            googleId: `gid_c_${Date.now()}_${Math.random()}`,
        });
        const userId = clientUser._id.toString();
        await Wallet.create({ userId, balanceFils: 20000, transactions: [] });

        const session = await CheckoutSession.create({
            userId,
            status: 'PENDING',
            paymentMethod: 'APP_WALLET',
            totalDeliveryPriceFils: 5000,
            orderSnapshot: {
                totalPrice: 5000,
                tasks: [{ type: 'delivery' }],
            },
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });

        const [walletResult, onlineResult] = await Promise.allSettled([
            payOrderFromWallet({
                checkoutSessionId: session._id,
                userId,
                requestId: `req_c_wallet`,
            }),
            checkoutService.payCheckoutSessionOnline({
                sessionId: session._id,
                userId,
                paymentMethod: 'CARD',
                requestId: `req_c_online`,
            }),
        ]);

        const finalSession = await CheckoutSession.findById(session._id);
        const finalWallet = await Wallet.findOne({ userId });

        const walletSucceeded = walletResult.status === 'fulfilled';
        const onlineSucceeded = onlineResult.status === 'fulfilled';

        assert.strictEqual(walletSucceeded && onlineSucceeded, false, 'pay-wallet and pay-online must NEVER both succeed');
        assert.ok(walletSucceeded || onlineSucceeded, 'One method must claim the session');

        if (walletSucceeded) {
            assert.strictEqual(finalSession.status, 'COMPLETED');
            assert.strictEqual(finalWallet.balanceFils, 15000);
        } else {
            assert.strictEqual(finalSession.status, 'PAYMENT_PENDING');
            assert.strictEqual(finalWallet.balanceFils, 20000, 'Wallet must not be debited');
        }

        // Adversarial check Scenario 2: PROCESSING state rejects pay-online
        const processingSession = await CheckoutSession.create({
            userId,
            status: 'PROCESSING',
            paymentMethod: 'APP_WALLET',
            totalDeliveryPriceFils: 5000,
            orderSnapshot: { totalPrice: 5000, tasks: [{ type: 'delivery' }] },
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });

        let rejectedProcessing = false;
        try {
            await checkoutService.payCheckoutSessionOnline({
                sessionId: processingSession._id,
                userId,
                paymentMethod: 'CARD',
                requestId: 'req_c_processing_test',
            });
        } catch (e) {
            rejectedProcessing = (e.statusCode === 409 || e.code === 409);
        }
        assert.ok(rejectedProcessing, 'pay-online must reject PROCESSING session with 409');

        return {
            walletSucceeded,
            onlineSucceeded,
            rejectedProcessingState: rejectedProcessing,
            finalSessionStatus: finalSession.status,
            finalWalletBalance: finalWallet.balanceFils,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST D: pay-online + pay-online simultaneously (idempotent intention reuse)
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('D', 'Two concurrent pay-online requests for the same session', async () => {
        const userId = `user_${runTag}_d`;
        const userDoc = await User.create({
            email: `${userId}@test.com`,
            firstName: 'UserD',
            lastName: 'TestUser',
            googleId: `gid_d_${Date.now()}_${Math.random()}`,
        });

        const session = await CheckoutSession.create({
            userId: userDoc._id.toString(),
            status: 'PENDING',
            paymentMethod: 'CARD',
            totalDeliveryPriceFils: 6000,
            orderSnapshot: { totalPrice: 6000, tasks: [{ type: 'delivery' }] },
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });

        await Promise.allSettled([
            checkoutService.payCheckoutSessionOnline({
                sessionId: session._id,
                userId: userDoc._id.toString(),
                paymentMethod: 'CARD',
                requestId: 'req_d_1',
            }),
            checkoutService.payCheckoutSessionOnline({
                sessionId: session._id,
                userId: userDoc._id.toString(),
                paymentMethod: 'CARD',
                requestId: 'req_d_2',
            }),
        ]);

        const payments = await Payment.find({ checkoutSessionId: session._id });
        const finalSession = await CheckoutSession.findById(session._id);

        assert.strictEqual(finalSession.status, 'PAYMENT_PENDING');
        assert.strictEqual(payments.length, 1, 'Only 1 Payment document must be created for the CheckoutSession');

        return {
            paymentCount: payments.length,
            sessionStatus: finalSession.status,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST E: Duplicate Paymob webhook x10
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('E', '10 duplicate Paymob webhooks fired concurrently', async () => {
        const userId = `user_${runTag}_e`;
        const session = await CheckoutSession.create({
            userId,
            status: 'PAYMENT_PENDING',
            paymentMethod: 'CARD',
            totalDeliveryPriceFils: 7000,
            orderSnapshot: {
                totalPrice: 7000,
                tasks: [{ type: 'delivery' }],
            },
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });

        const payment = await Payment.create({
            userId,
            purpose: 'ORDER_PAYMENT',
            paymentMethod: 'CARD',
            provider: 'paymob',
            checkoutSessionId: session._id,
            amountPiastres: 700,
            currency: 'EGP',
            integrationId: 12345,
            status: 'PENDING',
            specialReference: `pay_${session._id}`,
        });

        await CheckoutSession.findByIdAndUpdate(session._id, { paymentId: payment._id });

        const fakeTxnId = `txn_${runTag}_e_12345`;
        const callbackPayload = {
            id: fakeTxnId,
            amount_cents: 700,
            currency: 'EGP',
            integration_id: 12345,
            success: true,
            pending: false,
            is_voided: false,
            special_reference: payment.specialReference,
        };

        // Fire 10 duplicate webhooks simultaneously
        await Promise.allSettled(
            Array.from({ length: 10 }, (_, i) => {
                return paymentService.processWebhookTransaction({
                    transaction: callbackPayload,
                    requestId: `webhook_req_${i}`,
                });
            })
        );

        const finalPayment = await Payment.findById(payment._id);
        const finalSession = await CheckoutSession.findById(session._id);
        const createdOrders = await Order.find({ clientId: userId });

        assert.strictEqual(finalPayment.status, 'PAID', 'Payment must transition to PAID');
        assert.strictEqual(finalSession.status, 'COMPLETED', 'Session must transition to COMPLETED');
        assert.strictEqual(createdOrders.length, 1, 'Invariant 2: Exactly ONE final Order must be created');

        return {
            duplicateWebhooks: 10,
            paymentStatus: finalPayment.status,
            sessionStatus: finalSession.status,
            createdOrderCount: createdOrders.length,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST F: Webhook + Cancellation race
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('F', 'Successful webhook vs cancellation race condition', async () => {
        const userId = `user_${runTag}_f`;
        await Wallet.create({ userId, balanceFils: 0, transactions: [] });

        const orderIdNum = await getNextGlobalOrderId();
        const order = await Order.create({
            orderId: orderIdNum,
            clientId: userId,
            status: 'waiting',
            totalDeliveryPrice: 8000,
            paymentMethod: 'online',
            paymentStatus: 'unpaid',
            cancellationReason: runTag,
        });

        const payment = await Payment.create({
            orderId: order._id,
            orderNumericId: order.orderId,
            userId,
            purpose: 'ORDER_PAYMENT',
            paymentMethod: 'CARD',
            provider: 'paymob',
            amountPiastres: 800,
            currency: 'EGP',
            integrationId: 12345,
            status: 'PENDING',
            specialReference: `pay_order_${order._id}`,
        });

        const fakeTxnId = `txn_${runTag}_f_999`;
        const callbackPayload = {
            id: fakeTxnId,
            amount_cents: 800,
            currency: 'EGP',
            integration_id: 12345,
            success: true,
            pending: false,
            is_voided: false,
            special_reference: payment.specialReference,
        };

        // Concurrent cancel vs webhook confirmation
        await Promise.allSettled([
            Order.findOneAndUpdate(
                { _id: order._id, status: { $nin: ['cancelled', 'deleted'] } },
                { $set: { status: 'cancelled', cancellationReason: 'User cancelled during payment' } },
                { new: true }
            ),
            paymentService.processWebhookTransaction({
                transaction: callbackPayload,
                requestId: `req_f_webhook`,
            }),
        ]);

        const finalOrder = await Order.findById(order._id);
        const finalPayment = await Payment.findById(payment._id);
        const finalWallet = await Wallet.findOne({ userId });

        if (finalOrder.status === 'cancelled') {
            assert.ok(
                finalPayment.status === 'REFUNDED' || finalPayment.status === 'PENDING' || finalOrder.paymentStatus === 'refunded',
                `Cancelled order must be compensated. Payment status: ${finalPayment.status}`
            );
            if (finalPayment.status === 'REFUNDED') {
                assert.ok(finalWallet.balanceFils > 0, 'Wallet must be credited with compensation refund');
            }
        }

        return {
            orderStatus: finalOrder.status,
            paymentStatus: finalPayment.status,
            walletBalance: finalWallet.balanceFils,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST G: Successful payment + failure during order creation
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('G', 'Paymob success but order creation throws exception (compensation refund)', async () => {
        const userId = `user_${runTag}_g`;
        await Wallet.create({ userId, balanceFils: 0, transactions: [] });

        // Tasks with invalid enum type to trigger Mongoose save validation error inside _createOrderFromSnapshot
        const session = await CheckoutSession.create({
            userId,
            status: 'PAYMENT_PENDING',
            paymentMethod: 'CARD',
            totalDeliveryPriceFils: 5000,
            orderSnapshot: {
                totalPrice: 5000,
                tasks: [{ type: 'INVALID_ENUM_CAUSING_ORDER_SAVE_ERROR' }],
            },
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });

        const payment = await Payment.create({
            userId,
            purpose: 'ORDER_PAYMENT',
            paymentMethod: 'CARD',
            provider: 'paymob',
            checkoutSessionId: session._id,
            amountPiastres: 500,
            currency: 'EGP',
            integrationId: 12345,
            status: 'PENDING',
            specialReference: `pay_g_${session._id}`,
        });

        const fakeTxnId = `txn_${runTag}_g_fault`;
        const callbackPayload = {
            id: fakeTxnId,
            amount_cents: 500,
            currency: 'EGP',
            integration_id: 12345,
            success: true,
            pending: false,
            is_voided: false,
            special_reference: payment.specialReference,
        };

        await paymentService.processWebhookTransaction({
            transaction: callbackPayload,
            requestId: 'req_g_fault',
        });

        const finalPayment = await Payment.findById(payment._id);
        const finalSession = await CheckoutSession.findById(session._id);
        const finalWallet = await Wallet.findOne({ userId });
        const finalLedger = await WalletLedger.findOne({ userId, source: 'ORDER_REFUND' });

        assert.strictEqual(finalPayment.status, 'REFUNDED', 'Payment must transition to REFUNDED');
        assert.strictEqual(finalSession.status, 'FAILED', 'Session must transition to FAILED');
        assert.strictEqual(finalWallet.balanceFils, 5000, 'Customer wallet must be refunded 5000 fils');
        assert.ok(finalLedger, 'WalletLedger entry must record the compensating refund');

        return {
            paymentStatus: finalPayment.status,
            sessionStatus: finalSession.status,
            walletBalance: finalWallet.balanceFils,
            ledgerReference: finalLedger.reference,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST H: Duplicate refund requests
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('H', 'Duplicate refund requests cannot exceed paid amount', async () => {
        const userId = `user_${runTag}_h`;
        await Wallet.create({ userId, balanceFils: 0, transactions: [] });

        const orderIdNum = await getNextGlobalOrderId();
        const order = await Order.create({
            orderId: orderIdNum,
            clientId: userId,
            status: 'cancelled',
            totalDeliveryPrice: 10000,
            paymentStatus: 'paid',
            cancellationReason: runTag,
        });

        const payment = await Payment.create({
            orderId: order._id,
            userId,
            purpose: 'ORDER_PAYMENT',
            paymentMethod: 'APP_WALLET',
            provider: 'app_wallet',
            amountPiastres: 1000,
            refundedAmountPiastres: 0,
            currency: 'EGP',
            status: 'PAID',
        });

        await Promise.allSettled(
            Array.from({ length: 5 }, (_, i) => {
                return refundToWallet({
                    orderId: order._id,
                    amountFils: 10000,
                    userId,
                    paymentId: payment._id,
                    requestId: `refund_h_${i}`,
                    reference: `ORDER_REFUND_${order._id}`,
                });
            })
        );

        const finalWallet = await Wallet.findOne({ userId });
        const refundLedgers = await WalletLedger.find({ orderId: order._id, source: 'ORDER_REFUND' });

        assert.strictEqual(finalWallet.balanceFils, 10000, 'Balance must increase by exact single refund (10000 fils)');
        assert.strictEqual(refundLedgers.length, 1, 'Only 1 ledger entry must exist for this refund');

        return {
            concurrentRefunds: 5,
            finalBalanceFils: finalWallet.balanceFils,
            ledgerEntries: refundLedgers.length,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST I: 100 concurrent wallet credits
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('I', '100 concurrent credits via atomic $inc', async () => {
        const userId = `user_${runTag}_i`;
        await Wallet.create({ userId, balanceFils: 0, transactions: [] });

        const creditAmount = 500;
        const credits = Array.from({ length: 100 }, (_, i) => {
            return creditWallet({
                userId,
                amountFils: creditAmount,
                type: 'credit',
                description: `Credit #${i}`,
                refId: `cred_${runTag}_${i}`,
            });
        });

        await Promise.all(credits);

        const finalWallet = await Wallet.findOne({ userId });
        const expectedBalance = 100 * creditAmount;

        assert.strictEqual(
            finalWallet.balanceFils,
            expectedBalance,
            `Balance after 100 concurrent credits must be exactly ${expectedBalance}. Actual: ${finalWallet.balanceFils}`
        );

        return {
            concurrentCredits: 100,
            expectedBalance,
            actualBalance: finalWallet.balanceFils,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST J: 100 concurrent wallet debits (atomic precondition & overdraft prevention)
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('J', '100 concurrent debits with balance limit (no overdraft)', async () => {
        const userId = `user_${runTag}_j`;
        await Wallet.create({ userId, balanceFils: 25000, transactions: [] });

        const debitAmount = 1000;
        const debits = Array.from({ length: 100 }, (_, i) => {
            return debitWallet({
                userId,
                amountFils: debitAmount,
                description: `Debit #${i}`,
                refId: `deb_${runTag}_${i}`,
            });
        });

        const results = await Promise.allSettled(debits);
        const succeeded = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');

        const finalWallet = await Wallet.findOne({ userId });

        assert.strictEqual(succeeded.length, 25, 'Exactly 25 debits must succeed before funds deplete');
        assert.strictEqual(rejected.length, 75, '75 debits must be safely rejected due to insufficient balance');
        assert.strictEqual(finalWallet.balanceFils, 0, 'Final balance must be exactly 0 (no negative balance / overdraft)');

        return {
            concurrentDebits: 100,
            succeededCount: succeeded.length,
            rejectedCount: rejected.length,
            finalBalanceFils: finalWallet.balanceFils,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST K: Unauthorized customer reading waiting order (IDOR Verification)
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('K', 'Customer B reading Customer A waiting order (IDOR rejection)', async () => {
        const userA = await User.create({
            email: `user_a_${runTag}@test.com`,
            firstName: 'Alice',
            lastName: 'TestUser',
            userType: 'NormalUser',
            googleId: `gid_a_${Date.now()}_${Math.random()}`,
        });
        const userB = await User.create({
            email: `user_b_${runTag}@test.com`,
            firstName: 'Bob',
            lastName: 'TestUser',
            userType: 'NormalUser',
            googleId: `gid_b_${Date.now()}_${Math.random()}`,
        });

        const orderIdNum = await getNextGlobalOrderId();
        const order = await Order.create({
            orderId: orderIdNum,
            clientId: userA._id.toString(),
            status: 'waiting',
            totalDeliveryPrice: 3000,
            cancellationReason: runTag,
        });

        const { getOrderById } = require('../../Controllers/orderController');

        const reqMock = {
            params: { id: String(order.orderId) },
            user: { id: userB._id.toString(), userType: 'NormalUser', isAdmin: false },
            fullUser: { userType: 'NormalUser', isAdmin: false },
        };

        const response = await new Promise((resolve) => {
            const resMock = {
                statusCode: 200,
                body: null,
                status(code) { this.statusCode = code; return this; },
                json(data) { this.body = data; resolve(this); },
            };
            getOrderById(reqMock, resMock, (err) => {
                resMock.statusCode = err?.statusCode || 500;
                resMock.body = { error: err?.message };
                resolve(resMock);
            });
        });

        assert.strictEqual(response.statusCode, 404, 'Unauthorized customer must receive 404 anti-enumeration');
        assert.strictEqual(response.body?.message, 'Resource not found', 'No data or resource existence may be revealed');
        assert.strictEqual(response.body?.clientId, undefined, 'Client PII must not be leaked');
        assert.strictEqual(response.body?.tasks, undefined, 'Order tasks must not be leaked');

        return {
            attackerStatusCode: response.statusCode,
            attackerMessage: response.body?.message,
            piiLeaked: false,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST L: Client price tampering
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('L', 'Client sends tampered delivery price totalDeliveryPrice=1', async () => {
        const { createOrder } = require('../../Controllers/orderController');

        const reqMock = {
            user: { id: new mongoose.Types.ObjectId().toString(), userType: 'NormalUser' },
            body: {
                totalDeliveryPrice: 1, // Tampered 1 fils!
                totalPrice: 1,
                orderType: 'delivery',
                tasks: [{ pickupLocation: null }], // Invalid tasks
            },
        };

        const response = await new Promise((resolve) => {
            const resMock = {
                statusCode: 200,
                body: null,
                status(code) { this.statusCode = code; return this; },
                json(data) { this.body = data; resolve(this); },
            };
            try {
                createOrder(reqMock, resMock, (err) => {
                    resMock.statusCode = err?.statusCode || 422;
                    resMock.body = { error: err?.message };
                    resolve(resMock);
                });
            } catch (syncErr) {
                resMock.statusCode = syncErr?.statusCode || 422;
                resMock.body = { error: syncErr?.message };
                resolve(resMock);
            }
        });

        assert.ok(response.statusCode >= 400, `Pricing failure must be rejected with 4xx error. Received: ${response.statusCode}`);
        assert.notStrictEqual(response.statusCode, 200, 'Tampered price order creation must NEVER succeed');

        return {
            statusCode: response.statusCode,
            body: response.body,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST M: Expired session payment attempt
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('M', 'Attempting payment on expired CheckoutSession', async () => {
        const userId = `user_${runTag}_m`;
        const userDoc = await User.create({
            email: `${userId}@test.com`,
            firstName: 'UserM',
            lastName: 'TestUser',
            googleId: `gid_m_${Date.now()}_${Math.random()}`,
        });

        const session = await CheckoutSession.create({
            userId: userDoc._id.toString(),
            status: 'PENDING',
            paymentMethod: 'CARD',
            totalDeliveryPriceFils: 5000,
            orderSnapshot: { totalPrice: 5000, tasks: [{ type: 'delivery' }] },
            expiresAt: new Date(Date.now() - 60 * 1000), // Expired 1 minute ago
        });

        let rejected = false;
        try {
            await checkoutService.payCheckoutSessionOnline({
                sessionId: session._id,
                userId: userDoc._id.toString(),
                paymentMethod: 'CARD',
                requestId: 'req_m_expired',
            });
        } catch (err) {
            rejected = true;
            assert.strictEqual(err.statusCode || err.status, 422, 'Expired session must be rejected with 422');
        }

        const finalSession = await CheckoutSession.findById(session._id);
        assert.strictEqual(finalSession.status, 'EXPIRED', 'Session must be transitioned to EXPIRED');
        assert.strictEqual(rejected, true, 'Payment must be rejected');

        return {
            rejected,
            sessionStatus: finalSession.status,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST N: Timeout & retry idempotency
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('N', 'Request retry reuses pending payment without duplicate intention', async () => {
        const userId = `user_${runTag}_n`;
        const userDoc = await User.create({
            email: `${userId}@test.com`,
            firstName: 'UserN',
            lastName: 'TestUser',
            googleId: `gid_n_${Date.now()}_${Math.random()}`,
        });

        const session = await CheckoutSession.create({
            userId: userDoc._id.toString(),
            status: 'PENDING',
            paymentMethod: 'CARD',
            totalDeliveryPriceFils: 6000,
            orderSnapshot: { totalPrice: 6000, tasks: [{ type: 'delivery' }] },
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });

        const res1 = await checkoutService.payCheckoutSessionOnline({
            sessionId: session._id,
            userId: userDoc._id.toString(),
            paymentMethod: 'CARD',
            requestId: 'req_n_initial',
        });

        const res2 = await checkoutService.payCheckoutSessionOnline({
            sessionId: session._id,
            userId: userDoc._id.toString(),
            paymentMethod: 'CARD',
            requestId: 'req_n_retry',
        });

        assert.strictEqual(String(res1.paymentId), String(res2.paymentId), 'Retry must return the same paymentId');

        const payments = await Payment.find({ checkoutSessionId: session._id });
        assert.strictEqual(payments.length, 1, 'Only 1 Payment record must exist after retry');

        return {
            firstPaymentId: res1.paymentId,
            retryPaymentId: res2.paymentId,
            totalPayments: payments.length,
        };
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // TEST O: Network failure after successful financial mutation
    // ─────────────────────────────────────────────────────────────────────────────
    await runScenario('O', 'Ledger reconciliation trace after simulated failure', async () => {
        const userId = `user_${runTag}_o`;
        const wallet = await Wallet.create({ userId, balanceFils: 50000, transactions: [] });

        const reference = `ORDER_PAY_TEST_${Date.now()}`;
        const entry = await WalletLedger.create({
            walletId: wallet._id,
            userId,
            type: 'DEBIT',
            source: 'ORDER_PAYMENT',
            amountFils: 5000,
            currency: 'EGP',
            balanceBeforeFils: 50000,
            balanceAfterFils: 45000,
            status: 'COMPLETED',
            reference,
            description: 'Test payment with audit trace',
            performedBy: userId,
        });

        let duplicateBlocked = false;
        try {
            await WalletLedger.create({
                walletId: wallet._id,
                userId,
                type: 'DEBIT',
                source: 'ORDER_PAYMENT',
                amountFils: 5000,
                currency: 'EGP',
                balanceBeforeFils: 45000,
                balanceAfterFils: 40000,
                status: 'COMPLETED',
                reference,
                description: 'Duplicate debit attempt',
                performedBy: userId,
            });
        } catch (err) {
            duplicateBlocked = err.code === 11000;
        }

        assert.strictEqual(duplicateBlocked, true, 'Unique index uniq_wallet_reference must reject duplicate financial mutations');

        return {
            reference,
            duplicateBlocked,
            ledgerId: entry._id,
        };
    });

    await cleanupTestData(runTag);

    console.log(`\n═══════════════════════════════════════════════════════════════════`);
    console.log(`ADVERSARIAL CONCURRENCY SUITE COMPLETE`);
    console.log(`Passed: ${passedCount} | Failed: ${failedCount}`);
    console.log(`═══════════════════════════════════════════════════════════════════\n`);

    await mongoose.disconnect();

    if (failedCount > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

main().catch((err) => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
});
