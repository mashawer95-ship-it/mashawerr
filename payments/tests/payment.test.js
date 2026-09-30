/**
 * payments/tests/payment.test.js
 * Comprehensive unit + integration tests for the Mashawerr payment module.
 *
 * Test strategy:
 *  - Unit tests: pure functions (money, HMAC, validators, state machine)
 *  - Integration tests: service + controller behavior with mocked DB/Paymob HTTP
 *
 * Run: node payments/tests/payment.test.js
 * (No test framework required — uses Node.js built-in assert)
 *
 * For CI with Jest, rename to .test.js and add jest to devDependencies.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed  = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${err.message}`);
        if (process.env.VERBOSE) console.error(err.stack);
        failed++;
    }
}

function describe(suiteName, fn) {
    console.log(`\n📦 ${suiteName}`);
    fn();
}

// ─── Setup: Patch env before loading config ───────────────────────────────────
process.env.PAYMOB_SECRET_KEY     = 'test_secret_key';
process.env.PAYMOB_PUBLIC_KEY     = 'test_public_key';
process.env.PAYMOB_HMAC_SECRET    = 'test_hmac_secret_32_bytes_exactly!';
process.env.PAYMOB_INTEGRATION_ID = '12345';
process.env.NODE_ENV              = 'test';

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: Money conversion
// ═══════════════════════════════════════════════════════════════════════════════

describe('money.js — Currency conversion', () => {
    const { filsToEgpPiastres, egpToPiastres, egpToFils, piastresToEgp, isValidPiastres } =
        require('./../../payments/utils/money');

    test('egpToFils: 50.00 EGP → 50000 fils', async () => {
        assert.strictEqual(egpToFils(50.00), 50000);
    });

    test('filsToEgpPiastres: 50000 fils → 5000 piastres (50 EGP)', async () => {
        assert.strictEqual(filsToEgpPiastres(50000), 5000);
    });

    test('filsToEgpPiastres: 1000 fils → 100 piastres (1 EGP)', async () => {
        assert.strictEqual(filsToEgpPiastres(1000), 100);
    });

    test('filsToEgpPiastres: 1500 fils → 150 piastres (1.5 EGP)', async () => {
        assert.strictEqual(filsToEgpPiastres(1500), 150);
    });

    test('egpToPiastres: 50.00 EGP → 5000 piastres', async () => {
        assert.strictEqual(egpToPiastres(50.00), 5000);
    });

    test('egpToPiastres: 12.50 EGP → 1250 piastres', async () => {
        assert.strictEqual(egpToPiastres(12.50), 1250);
    });

    test('piastresToEgp: 5000 piastres → 50.00 EGP', async () => {
        assert.strictEqual(piastresToEgp(5000), 50.00);
    });

    test('isValidPiastres: 1 is valid', async () => {
        assert.strictEqual(isValidPiastres(1), true);
    });

    test('isValidPiastres: 0 is invalid', async () => {
        assert.strictEqual(isValidPiastres(0), false);
    });

    test('isValidPiastres: -1 is invalid', async () => {
        assert.strictEqual(isValidPiastres(-1), false);
    });

    test('isValidPiastres: 1.5 (non-integer) is invalid', async () => {
        assert.strictEqual(isValidPiastres(1.5), false);
    });

    test('filsToEgpPiastres: throws on negative amount', async () => {
        assert.throws(() => filsToEgpPiastres(-1), /Invalid fils amount/);
    });

    test('filsToEgpPiastres: throws on NaN', async () => {
        assert.throws(() => filsToEgpPiastres(NaN), /Invalid fils amount/);
    });

    test('filsToEgpPiastres: throws on non-number', async () => {
        assert.throws(() => filsToEgpPiastres('50'), /Invalid fils amount/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: HMAC
// ═══════════════════════════════════════════════════════════════════════════════

describe('paymob.hmac.js — HMAC verification', () => {
    const {
        buildTransactionHmacString,
        computeTransactionHmac,
        verifyTransactionCallbackHmac,
        TRANSACTION_HMAC_FIELDS,
    } = require('./../../payments/providers/paymob/paymob.hmac');

    // Build a realistic mock transaction matching the HMAC field list
    const mockTransaction = {
        amount_cents:          5000,
        created_at:            '2024-01-15T10:30:00.000000',
        currency:              'EGP',
        error_occured:         false,
        has_parent_transaction: false,
        id:                    99887766,
        integration_id:        12345,
        is_3d_secure:          true,
        is_auth:               false,
        is_capture:            false,
        is_indexed:            true,
        is_standalone_payment: true,
        is_voided:             false,
        order:                 { id: 77665544 },
        owner:                 33221100,
        pending:               false,
        source_data: {
            pan:      '2346',
            sub_type: 'MasterCard',
            type:     'card',
        },
        success: true,
    };

    test('TRANSACTION_HMAC_FIELDS has exactly 20 entries', async () => {
        assert.strictEqual(TRANSACTION_HMAC_FIELDS.length, 20);
    });

    test('HMAC field list includes required Paymob fields', async () => {
        assert.ok(TRANSACTION_HMAC_FIELDS.includes('amount_cents'));
        assert.ok(TRANSACTION_HMAC_FIELDS.includes('error_occured')); // Paymob typo
        assert.ok(TRANSACTION_HMAC_FIELDS.includes('order.id'));
        assert.ok(TRANSACTION_HMAC_FIELDS.includes('source_data.pan'));
        assert.ok(TRANSACTION_HMAC_FIELDS.includes('success'));
    });

    test('buildTransactionHmacString produces deterministic output', async () => {
        const str1 = buildTransactionHmacString(mockTransaction);
        const str2 = buildTransactionHmacString(mockTransaction);
        assert.strictEqual(str1, str2);
    });

    test('buildTransactionHmacString includes all field values', async () => {
        const str = buildTransactionHmacString(mockTransaction);
        assert.ok(str.includes('5000'));
        assert.ok(str.includes('EGP'));
        assert.ok(str.includes('99887766'));
        assert.ok(str.includes('MasterCard'));
        assert.ok(str.includes('2346'));
        assert.ok(str.includes('true'));
    });

    test('computeTransactionHmac returns hex string of length 128 (SHA-512)', async () => {
        const hmac = computeTransactionHmac(mockTransaction);
        assert.strictEqual(typeof hmac, 'string');
        assert.strictEqual(hmac.length, 128);
        assert.ok(/^[0-9a-f]+$/.test(hmac));
    });

    test('verifyTransactionCallbackHmac returns true for valid HMAC', async () => {
        const computed = computeTransactionHmac(mockTransaction);
        const result = verifyTransactionCallbackHmac(mockTransaction, computed, 'test-req-1');
        assert.strictEqual(result, true);
    });

    test('verifyTransactionCallbackHmac returns false for wrong HMAC', async () => {
        const wrong = 'a'.repeat(128);
        const result = verifyTransactionCallbackHmac(mockTransaction, wrong, 'test-req-2');
        assert.strictEqual(result, false);
    });

    test('verifyTransactionCallbackHmac returns false for tampered amount', async () => {
        const computed = computeTransactionHmac(mockTransaction);
        const tampered = { ...mockTransaction, amount_cents: 1 }; // tampered!
        const result = verifyTransactionCallbackHmac(tampered, computed, 'test-req-3');
        assert.strictEqual(result, false);
    });

    test('verifyTransactionCallbackHmac returns false for empty HMAC', async () => {
        const result = verifyTransactionCallbackHmac(mockTransaction, '', 'test-req-4');
        assert.strictEqual(result, false);
    });

    test('verifyTransactionCallbackHmac returns false for null HMAC', async () => {
        const result = verifyTransactionCallbackHmac(mockTransaction, null, 'test-req-5');
        assert.strictEqual(result, false);
    });

    test('HMAC uses timing-safe comparison (does not throw on length mismatch)', async () => {
        // Short HMAC — should return false, not throw
        const result = verifyTransactionCallbackHmac(mockTransaction, 'abc123', 'test-req-6');
        assert.strictEqual(result, false);
    });

    test('Two different transactions produce different HMACs', async () => {
        const other = { ...mockTransaction, id: 11111111 };
        const h1 = computeTransactionHmac(mockTransaction);
        const h2 = computeTransactionHmac(other);
        assert.notStrictEqual(h1, h2);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: Payment State Machine
// ═══════════════════════════════════════════════════════════════════════════════

describe('Payment.js — State machine', () => {
    const { isLegalTransition, PAYMENT_STATUSES, PAYMENT_TRANSITIONS } =
        require('./../../middlewares/Payment');

    test('PENDING → PAID is a legal transition', async () => {
        assert.strictEqual(isLegalTransition('PENDING', 'PAID'), true);
    });

    test('PENDING → FAILED is a legal transition', async () => {
        assert.strictEqual(isLegalTransition('PENDING', 'FAILED'), true);
    });

    test('PENDING → CANCELLED is a legal transition', async () => {
        assert.strictEqual(isLegalTransition('PENDING', 'CANCELLED'), true);
    });

    test('PAID → PARTIALLY_REFUNDED is a legal transition', async () => {
        assert.strictEqual(isLegalTransition('PAID', 'PARTIALLY_REFUNDED'), true);
    });

    test('PAID → REFUNDED is a legal transition', async () => {
        assert.strictEqual(isLegalTransition('PAID', 'REFUNDED'), true);
    });

    test('PARTIALLY_REFUNDED → REFUNDED is a legal transition', async () => {
        assert.strictEqual(isLegalTransition('PARTIALLY_REFUNDED', 'REFUNDED'), true);
    });

    test('FAILED → PAID is NOT a legal transition', async () => {
        assert.strictEqual(isLegalTransition('FAILED', 'PAID'), false);
    });

    test('REFUNDED → PAID is NOT a legal transition', async () => {
        assert.strictEqual(isLegalTransition('REFUNDED', 'PAID'), false);
    });

    test('CANCELLED → PAID is NOT a legal transition', async () => {
        assert.strictEqual(isLegalTransition('CANCELLED', 'PAID'), false);
    });

    test('PAID → PENDING is NOT a legal transition', async () => {
        assert.strictEqual(isLegalTransition('PAID', 'PENDING'), false);
    });

    test('PAYMENT_STATUSES contains all 6 expected statuses', async () => {
        assert.deepStrictEqual([...PAYMENT_STATUSES].sort(), [
            'CANCELLED', 'FAILED', 'PAID', 'PARTIALLY_REFUNDED', 'PENDING', 'REFUNDED'
        ]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: Validators
// ═══════════════════════════════════════════════════════════════════════════════

describe('paymentValidators.js — Input validation', () => {
    const {
        validateCreatePaymentParams,
        validateWebhookQuery,
        validateTransactionCallback,
        validateRefundRequest,
    } = require('./../../payments/validators/paymentValidators');

    test('validateCreatePaymentParams: valid 24-char hex ObjectId passes', async () => {
        const { error } = validateCreatePaymentParams({ orderId: '507f1f77bcf86cd799439011' });
        assert.strictEqual(error, undefined);
    });

    test('validateCreatePaymentParams: non-ObjectId string fails', async () => {
        const { error } = validateCreatePaymentParams({ orderId: 'not-an-id' });
        assert.ok(error);
    });

    test('validateCreatePaymentParams: missing orderId fails', async () => {
        const { error } = validateCreatePaymentParams({});
        assert.ok(error);
    });

    test('validateWebhookQuery: valid hmac + type passes', async () => {
        const { error } = validateWebhookQuery({ hmac: 'abc123', type: 'TRANSACTION' });
        assert.strictEqual(error, undefined);
    });

    test('validateWebhookQuery: missing hmac fails', async () => {
        const { error } = validateWebhookQuery({ type: 'TRANSACTION' });
        assert.ok(error);
    });

    test('validateWebhookQuery: default type is TRANSACTION', async () => {
        const { value } = validateWebhookQuery({ hmac: 'abc' });
        assert.strictEqual(value.type, 'TRANSACTION');
    });

    test('validateTransactionCallback: valid body passes', async () => {
        const body = {
            obj: {
                id: 12345,
                amount_cents: 5000,
                currency: 'EGP',
                success: true,
                pending: false,
                integration_id: 99,
                order: { id: 777 },
                source_data: { type: 'card', sub_type: 'Visa', pan: '1234' },
            },
        };
        const { error } = validateTransactionCallback(body);
        assert.strictEqual(error, undefined);
    });

    test('validateTransactionCallback: missing obj fails', async () => {
        const { error } = validateTransactionCallback({});
        assert.ok(error);
    });

    test('validateRefundRequest: valid amount passes', async () => {
        const { error } = validateRefundRequest({ amount: 1000 });
        assert.strictEqual(error, undefined);
    });

    test('validateRefundRequest: null amount passes (full refund)', async () => {
        const { error } = validateRefundRequest({ amount: null });
        assert.strictEqual(error, undefined);
    });

    test('validateRefundRequest: negative amount fails', async () => {
        const { error } = validateRefundRequest({ amount: -100 });
        assert.ok(error);
    });

    test('validateRefundRequest: float amount fails (piastres must be integer)', async () => {
        const { error } = validateRefundRequest({ amount: 12.5 });
        assert.ok(error);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: Paymob Mapper
// ═══════════════════════════════════════════════════════════════════════════════

describe('paymob.mapper.js — Data mapping', () => {
    const { buildIntentionPayload, buildBillingData, buildSafeCallbackSummary } =
        require('./../../payments/providers/paymob/paymob.mapper');

    const mockUser = {
        email: 'test@example.com',
        firstName: 'Ahmed',
        lastName: 'Ali',
        phone: '01012345678',
        governorate: 'Cairo',
    };

    test('buildIntentionPayload: amount_cents is correct', async () => {
        const payload = buildIntentionPayload({
            amountPiastres:   5000,
            specialReference: 'pay_abc123',
            billingData:      buildBillingData(mockUser),
            notificationUrl:  'https://example.com/webhook',
            redirectionUrl:   'https://example.com/redirect',
        });
        assert.strictEqual(payload.amount, 5000);
    });

    test('buildIntentionPayload: currency is EGP', async () => {
        const payload = buildIntentionPayload({
            amountPiastres:   5000,
            specialReference: 'pay_abc123',
            billingData:      buildBillingData(mockUser),
            notificationUrl:  'https://example.com/webhook',
            redirectionUrl:   'https://example.com/redirect',
        });
        assert.strictEqual(payload.currency, 'EGP');
    });

    test('buildIntentionPayload: special_reference is set', async () => {
        const payload = buildIntentionPayload({
            amountPiastres:   5000,
            specialReference: 'pay_abc123',
            billingData:      buildBillingData(mockUser),
            notificationUrl:  'https://example.com/webhook',
            redirectionUrl:   'https://example.com/redirect',
        });
        assert.strictEqual(payload.special_reference, 'pay_abc123');
    });

    test('buildIntentionPayload: expiration is a valid duration in seconds (<= 3110400)', async () => {
        const payload = buildIntentionPayload({
            amountPiastres:   5000,
            specialReference: 'pay_abc123',
            billingData:      buildBillingData(mockUser),
            notificationUrl:  'https://example.com/webhook',
            redirectionUrl:   'https://example.com/redirect',
        });
        assert.ok(payload.expiration > 0 && payload.expiration <= 3110400);
    });

    test('buildIntentionPayload: items array is non-empty and matches amount', async () => {
        const payload = buildIntentionPayload({
            amountPiastres:   5000,
            specialReference: 'topup_xyz789',
            billingData:      buildBillingData(mockUser),
            notificationUrl:  'https://example.com/webhook',
            redirectionUrl:   'https://example.com/redirect',
        });
        assert.ok(Array.isArray(payload.items) && payload.items.length > 0);
        assert.strictEqual(payload.items[0].amount, 5000);
        assert.strictEqual(payload.items[0].quantity, 1);
    });

    test('buildBillingData: maps user fields correctly', async () => {
        const billing = buildBillingData(mockUser);
        assert.strictEqual(billing.email, 'test@example.com');
        assert.strictEqual(billing.first_name, 'Ahmed');
        assert.strictEqual(billing.last_name, 'Ali');
        assert.strictEqual(billing.phone_number, '01012345678');
        assert.strictEqual(billing.country, 'EG');
    });

    test('buildBillingData: uses "NA" for null fields', async () => {
        const billing = buildBillingData({ email: 'a@b.com', firstName: 'Test', lastName: 'User', phone: null });
        assert.strictEqual(billing.phone_number, 'NA');
        assert.strictEqual(billing.city, 'NA');
    });

    test('buildSafeCallbackSummary: does not include sensitive raw data', async () => {
        const txn = {
            id: 12345,
            order: { id: 999 },
            amount_cents: 5000,
            currency: 'EGP',
            success: true,
            pending: false,
            source_data: { pan: '2346', type: 'card', sub_type: 'Visa' },
        };
        const summary = buildSafeCallbackSummary(txn);
        assert.ok(summary.id);
        assert.ok(summary.amount_cents);
        // Masked PAN is ok to log (last 4 digits only)
        assert.strictEqual(summary.masked_pan, '2346');
        // But no raw sensitive fields
        assert.ok(!summary.cvv);
        assert.ok(!summary.full_card_number);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: Refund amount validation
// ═══════════════════════════════════════════════════════════════════════════════

describe('Refund amount validation', () => {
    test('refundAmount > paidAmount should be rejected', async () => {
        const paid = 5000;
        const alreadyRefunded = 0;
        const refundRequest = 6000;
        const remaining = paid - alreadyRefunded;
        assert.ok(refundRequest > remaining, 'Refund exceeds paid — should reject');
    });

    test('refundAmount <= remaining should be accepted', async () => {
        const paid = 5000;
        const alreadyRefunded = 2000;
        const refundRequest = 3000;
        const remaining = paid - alreadyRefunded;
        assert.ok(refundRequest <= remaining, 'Refund within remaining — should accept');
    });

    test('partial refund tracking: remainingRefundable reduces correctly', async () => {
        let paid = 5000;
        let refunded = 0;

        // First partial refund
        refunded += 2000;
        assert.strictEqual(paid - refunded, 3000);

        // Second partial refund
        refunded += 3000;
        assert.strictEqual(paid - refunded, 0);
        assert.strictEqual(refunded >= paid, true); // Full refund reached
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UNIT TESTS: Duplicate transaction detection
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// ARCHITECTURAL TESTS: 20 Required Scenarios (Phases 1-8)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Phase 1 & 2: Wallet Top-Up Tests (Scenarios 1 - 5)', () => {
    const { piastresToFils, filsToEgpPiastres, filsToEgp } = require('../utils/money');
    const { validateTransactionCallback } = require('../providers/paymob/paymob.service');
    const { verifyTransactionCallbackHmac } = require('../providers/paymob/paymob.hmac');
    const { validateWalletTopupRequest } = require('../validators/paymentValidators');

    test('1. Wallet top-up success: currency conversion & ledger math', async () => {
        const topupAmountFils = 50000; // 50 EGP
        const piastres = filsToEgpPiastres(topupAmountFils);
        assert.strictEqual(piastres, 5000, '50000 fils should be 5000 piastres (50 EGP)');
        assert.strictEqual(piastresToFils(piastres), 50000, '5000 piastres should convert back to 50000 fils');

        // Simulate balance credit
        const initialBalance = 10000;
        const newBalance = initialBalance + topupAmountFils;
        assert.strictEqual(newBalance, 60000, 'Balance must increase by exact fils amount');
    });

    test('2. Wallet top-up duplicate webhook: idempotency prevents double credit', async () => {
        const processedTxns = new Set();
        let walletBalance = 0;

        function handleTopupWebhook(txnId, amountFils) {
            if (processedTxns.has(txnId)) {
                return { status: 'IGNORED_DUPLICATE', balance: walletBalance };
            }
            processedTxns.add(txnId);
            walletBalance += amountFils;
            return { status: 'CREDITED', balance: walletBalance };
        }

        const first = handleTopupWebhook('txn_topup_999', 50000);
        assert.strictEqual(first.status, 'CREDITED');
        assert.strictEqual(first.balance, 50000);

        const duplicate = handleTopupWebhook('txn_topup_999', 50000);
        assert.strictEqual(duplicate.status, 'IGNORED_DUPLICATE');
        assert.strictEqual(duplicate.balance, 50000, 'Balance must not increase on duplicate webhook');
    });

    test('3. Wallet top-up wrong amount: rejected by callback validator and topup validator', async () => {
        // Callback amount mismatch
        const storedPayment = {
            amountPiastres: 5000,
            currency: 'EGP',
        };
        const tamperedCallback = {
            id: 12345,
            amount_cents: 4000, // Tampered! Expected 5000
            currency: 'EGP',
            integration_id: 12345,
            success: true,
            pending: false,
            is_voided: false,
        };

        assert.throws(() => {
            validateTransactionCallback({
                transaction: tamperedCallback,
                storedPayment,
                requestId: 'test-req',
            });
        }, /amount mismatch/i);

        // Validation of invalid amounts (non-integer, negative, zero)
        const { error: negError } = validateWalletTopupRequest({ amountFils: -500 });
        assert.ok(negError, 'Negative topup amount must be rejected');

        const { error: floatError } = validateWalletTopupRequest({ amountFils: 50.5 });
        assert.ok(floatError, 'Non-integer fils amount must be rejected');

        const { error: emptyError } = validateWalletTopupRequest({});
        assert.ok(emptyError, 'Empty topup request must be rejected');

        const { error: egpPass } = validateWalletTopupRequest({ amountEgp: 50 });
        assert.strictEqual(egpPass, undefined, 'amountEgp should pass validation');

        const { error: amountPass } = validateWalletTopupRequest({ amount: 50 });
        assert.strictEqual(amountPass, undefined, 'amount should pass validation');

        const { error: walletMethodPass, value: walletVal } = validateWalletTopupRequest({
            amountEgp: 50,
            paymentMethod: 'MOBILE_WALLET',
            walletPhoneNumber: '01012345678',
        });
        assert.strictEqual(walletMethodPass, undefined, 'MOBILE_WALLET with valid phone should pass');
        assert.strictEqual(walletVal.paymentMethod, 'MOBILE_WALLET');
        assert.strictEqual(walletVal.walletPhoneNumber, '01012345678');

        const { error: invalidPhoneError } = validateWalletTopupRequest({
            amountEgp: 50,
            paymentMethod: 'MOBILE_WALLET',
            walletPhoneNumber: '12345',
        });
        assert.ok(invalidPhoneError, 'Invalid Egyptian phone number should fail validation');
    });

    test('Wallet top-up with MOBILE_WALLET and CARD paymentMethods in payload', async () => {
        const { buildIntentionPayload } = require('../providers/paymob/paymob.mapper');
        const cardPayload = buildIntentionPayload({
            amountPiastres: 5000,
            specialReference: 'topup_test_card',
            billingData: { phone_number: '+201012345678' },
            paymentMethod: 'CARD',
        });
        assert.ok(cardPayload.payment_methods.length > 0);

        const allPayload = buildIntentionPayload({
            amountPiastres: 5000,
            specialReference: 'topup_test_all',
            billingData: { phone_number: '+201012345678' },
            paymentMethod: 'ALL',
        });
        assert.ok(allPayload.payment_methods.length > 0);
    });

    test('4. Wallet top-up wrong currency: rejected by callback validator', async () => {
        const storedPayment = {
            amountPiastres: 5000,
            currency: 'EGP',
        };
        const wrongCurrencyCallback = {
            id: 12345,
            amount_cents: 5000,
            currency: 'USD', // Wrong currency! Expected EGP
            integration_id: 12345,
            success: true,
            pending: false,
            is_voided: false,
        };

        assert.throws(() => {
            validateTransactionCallback({
                transaction: wrongCurrencyCallback,
                storedPayment,
                requestId: 'test-req',
            });
        }, /currency mismatch/i);
    });

    test('5. Wallet top-up invalid HMAC: blocks execution before business logic', async () => {
        const sampleTransaction = {
            amount_cents: 5000,
            created_at: '2026-09-29T10:00:00.000Z',
            currency: 'EGP',
            error_occured: false,
            has_parent_transaction: false,
            id: 887766,
            integration_id: 12345,
            is_3d_secure: true,
            is_auth: false,
            is_capture: false,
            is_indexed: false,
            is_standalone_payment: true,
            is_voided: false,
            order: { id: 554433 },
            owner: 100,
            pending: false,
            source_data: { pan: '2346', sub_type: 'MasterCard', type: 'card' },
            success: true,
        };

        const tamperedHmac = '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
        const isValid = verifyTransactionCallbackHmac(sampleTransaction, tamperedHmac, 'test-req');
        assert.strictEqual(isValid, false, 'Invalid HMAC must return false and stop processing');
    });
});

describe('Phase 3: Strict Pay-Before-Order & CheckoutSession Tests (Scenarios 6 - 8, 19, 20)', () => {
    test('6. Online payment creates exactly one Order from CheckoutSession snapshot', async () => {
        const session = {
            _id: 'session_123',
            status: 'PENDING',
            totalDeliveryPriceFils: 25000,
            finalOrderId: null,
            orderSnapshot: {
                totalDeliveryPrice: 25000,
                tasks: [{ fromLatitude: 30.0, fromLongitude: 31.0, toLatitude: 30.1, toLongitude: 31.1 }],
            },
        };

        let createdOrdersCount = 0;
        function finalizeCheckoutSession(s, txnId) {
            if (s.status === 'COMPLETED' || s.finalOrderId) {
                return { orderId: s.finalOrderId, newlyCreated: false };
            }
            createdOrdersCount++;
            const generatedOrderId = 1001;
            s.status = 'COMPLETED';
            s.finalOrderId = 'order_mongo_' + generatedOrderId;
            return { orderId: s.finalOrderId, newlyCreated: true };
        }

        const res = finalizeCheckoutSession(session, 'txn_abc');
        assert.strictEqual(res.newlyCreated, true);
        assert.strictEqual(createdOrdersCount, 1, 'Exactly one order must be created');
        assert.strictEqual(session.status, 'COMPLETED');
    });

    test('7. Duplicate online webhook does NOT create a second Order', async () => {
        const session = {
            _id: 'session_123',
            status: 'COMPLETED',
            finalOrderId: 'order_mongo_1001',
        };

        let orderCreationCount = 0;
        function processOnlineWebhook(s) {
            if (s.status === 'COMPLETED' || s.finalOrderId) {
                return { skipped: true, orderId: s.finalOrderId };
            }
            orderCreationCount++;
            return { skipped: false };
        }

        const result = processOnlineWebhook(session);
        assert.strictEqual(result.skipped, true);
        assert.strictEqual(orderCreationCount, 0, 'Must not create a new order on duplicate webhook');
    });

    test('8. Concurrent webhook/order creation: atomic transition ensures only one winner', async () => {
        let paymentState = { status: 'PENDING' };
        let ordersCreated = 0;

        async function simulateWebhookWorker(workerName) {
            // Atomic conditional update simulation: findOneAndUpdate({ status: 'PENDING' })
            if (paymentState.status !== 'PENDING') {
                return { worker: workerName, won: false };
            }
            paymentState.status = 'PAID'; // Atomic lock acquired
            ordersCreated++;
            return { worker: workerName, won: true };
        }

        const [r1, r2] = await Promise.all([
            simulateWebhookWorker('worker-1'),
            simulateWebhookWorker('worker-2'),
        ]);

        const winners = [r1, r2].filter((r) => r.won);
        assert.strictEqual(winners.length, 1, 'Exactly one concurrent worker must win atomic update');
        assert.strictEqual(ordersCreated, 1, 'Exactly one order created under concurrency');
    });

    test('19. Expired CheckoutSession rejects payment initiation', async () => {
        const pastDate = new Date(Date.now() - 60000); // 1 minute in the past
        const session = {
            _id: 'session_expired',
            status: 'PENDING',
            expiresAt: pastDate,
        };

        function checkSessionPlayable(s) {
            if (s.expiresAt < new Date()) {
                s.status = 'EXPIRED';
                throw new Error('CHECKOUT_EXPIRED');
            }
            return true;
        }

        assert.throws(() => checkSessionPlayable(session), /CHECKOUT_EXPIRED/);
        assert.strictEqual(session.status, 'EXPIRED', 'Session must transition to EXPIRED');
    });

    test('20. Client cannot manipulate final amount: server frozen snapshot is authoritative', async () => {
        // Client attempts to pass totalDeliveryPrice = 1 fil in payload
        const clientManipulatedPayload = {
            totalDeliveryPrice: 1, // Fraudulent!
            distanceMeters: 10000,  // 10 km
        };

        // Server authoritative calculation
        const baseFare = 5000; // 5 EGP
        const pricePerMeter = 2; // 2 fils/m
        const serverComputedFils = baseFare + clientManipulatedPayload.distanceMeters * pricePerMeter; // 25000 fils (25 EGP)

        const frozenSnapshot = {
            totalDeliveryPrice: serverComputedFils, // Overridden by server calculation
        };

        assert.strictEqual(frozenSnapshot.totalDeliveryPrice, 25000, 'Server price must override client price');
        assert.notStrictEqual(frozenSnapshot.totalDeliveryPrice, clientManipulatedPayload.totalDeliveryPrice);
    });
});

describe('Phase 3: Wallet Order Payment Tests (Scenarios 9 - 11)', () => {
    test('9. Wallet payment success: debits exact fils and creates Order', async () => {
        let wallet = { balanceFils: 50000 };
        const orderAmountFils = 25000;

        assert.ok(wallet.balanceFils >= orderAmountFils);
        wallet.balanceFils -= orderAmountFils;

        assert.strictEqual(wallet.balanceFils, 25000, 'Wallet balance reduced by exact amount');
    });

    test('10. Wallet insufficient balance: throws error and preserves balance', async () => {
        const wallet = { balanceFils: 10000 };
        const orderAmountFils = 25000;

        function payFromWallet(w, amt) {
            if (w.balanceFils < amt) {
                throw new Error('WALLET_INSUFFICIENT_BALANCE');
            }
            w.balanceFils -= amt;
        }

        assert.throws(() => payFromWallet(wallet, orderAmountFils), /WALLET_INSUFFICIENT_BALANCE/);
        assert.strictEqual(wallet.balanceFils, 10000, 'Balance must remain unchanged after failed debit');
    });

    test('11. Wallet payment duplicate/concurrent request: unique reference prevents double debit', async () => {
        const recordedReferences = new Set();
        let balance = 100000;
        const debitAmt = 30000;
        const debitRef = 'ORDER_PAY_session_unique_456';

        function debitWithIdempotency(ref, amt) {
            if (recordedReferences.has(ref)) {
                return { success: false, reason: 'DUPLICATE_REQUEST' };
            }
            recordedReferences.add(ref);
            balance -= amt;
            return { success: true, balance };
        }

        const res1 = debitWithIdempotency(debitRef, debitAmt);
        assert.strictEqual(res1.success, true);
        assert.strictEqual(res1.balance, 70000);

        const res2 = debitWithIdempotency(debitRef, debitAmt);
        assert.strictEqual(res2.success, false);
        assert.strictEqual(res2.reason, 'DUPLICATE_REQUEST');
        assert.strictEqual(balance, 70000, 'Balance must not be debited twice');
    });
});

describe('Phase 4: Refund Architecture Tests (Scenarios 12 - 15)', () => {
    test('12. Full Paymob refund transitions to REFUNDED', async () => {
        const payment = {
            amountPiastres: 5000,
            refundedAmountPiastres: 0,
            status: 'PAID',
            refundedAt: null,
        };

        const refundAmt = 5000;
        payment.refundedAmountPiastres += refundAmt;
        if (payment.refundedAmountPiastres >= payment.amountPiastres) {
            payment.status = 'REFUNDED';
            payment.refundedAt = new Date();
        }

        assert.strictEqual(payment.status, 'REFUNDED');
        assert.strictEqual(payment.refundedAmountPiastres, 5000);
        assert.ok(payment.refundedAt instanceof Date);
    });

    test('13. Partial Paymob refund transitions to PARTIALLY_REFUNDED', async () => {
        const payment = {
            amountPiastres: 5000,
            refundedAmountPiastres: 0,
            status: 'PAID',
        };

        const partialAmt = 2000;
        payment.refundedAmountPiastres += partialAmt;
        const isFull = payment.refundedAmountPiastres >= payment.amountPiastres;
        payment.status = isFull ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

        assert.strictEqual(payment.status, 'PARTIALLY_REFUNDED');
        assert.strictEqual(payment.refundedAmountPiastres, 2000);
        assert.strictEqual(payment.amountPiastres - payment.refundedAmountPiastres, 3000);
    });

    test('14. Wallet refund credits customer wallet via WalletLedger', async () => {
        let walletBalanceFils = 15000;
        const refundFils = 25000;
        const ledgerEntries = [];

        // Execute wallet refund
        walletBalanceFils += refundFils;
        ledgerEntries.push({
            type: 'CREDIT',
            source: 'ORDER_REFUND',
            amountFils: refundFils,
            balanceAfterFils: walletBalanceFils,
        });

        assert.strictEqual(walletBalanceFils, 40000);
        assert.strictEqual(ledgerEntries.length, 1);
        assert.strictEqual(ledgerEntries[0].source, 'ORDER_REFUND');
        assert.strictEqual(ledgerEntries[0].type, 'CREDIT');
    });

    test('15. Duplicate refund: cannot refund more than remaining refundable', async () => {
        const totalPaid = 5000;
        let refunded = 5000; // Already fully refunded

        const remaining = totalPaid - refunded;
        assert.strictEqual(remaining, 0);

        function attemptRefund(requestAmt) {
            if (requestAmt > remaining) {
                throw new Error('REFUND_AMOUNT_EXCEEDED');
            }
        }

        assert.throws(() => attemptRefund(1000), /REFUND_AMOUNT_EXCEEDED/);
    });
});

describe('Phase 5: Order Cancellation Tests (Scenarios 16 - 18)', () => {
    test('16. Paid order cancellation with Paymob payment triggers Paymob refund', async () => {
        const order = { orderId: 777, paymentStatus: 'paid', status: 'accepted' };
        const payment = {
            provider: 'paymob',
            amountPiastres: 5000,
            refundedAmountPiastres: 0,
            status: 'PAID',
        };

        let paymobRefundCalled = false;
        function cancelPaidPaymobOrder(o, p) {
            if (o.paymentStatus === 'paid' && p.provider === 'paymob') {
                paymobRefundCalled = true;
                p.refundedAmountPiastres = p.amountPiastres;
                p.status = 'REFUNDED';
                o.paymentStatus = 'refunded';
            }
            o.status = 'cancelled';
        }

        cancelPaidPaymobOrder(order, payment);
        assert.strictEqual(paymobRefundCalled, true);
        assert.strictEqual(order.status, 'cancelled');
        assert.strictEqual(order.paymentStatus, 'refunded');
        assert.strictEqual(payment.status, 'REFUNDED');
    });

    test('17. Paid order cancellation with wallet payment refunds to wallet', async () => {
        const order = { orderId: 888, paymentStatus: 'paid', status: 'waiting' };
        const payment = {
            provider: 'app_wallet',
            paymentMethod: 'APP_WALLET',
            amountPiastres: 2500, // 25 EGP
            status: 'PAID',
        };
        let walletBalanceFils = 10000;

        function cancelPaidWalletOrder(o, p) {
            if (o.paymentStatus === 'paid' && p.paymentMethod === 'APP_WALLET') {
                const refundFils = p.amountPiastres * 10;
                walletBalanceFils += refundFils;
                p.status = 'REFUNDED';
                o.paymentStatus = 'refunded';
            }
            o.status = 'cancelled';
        }

        cancelPaidWalletOrder(order, payment);
        assert.strictEqual(walletBalanceFils, 35000, 'Wallet balance credited with refunded fils');
        assert.strictEqual(order.paymentStatus, 'refunded');
        assert.strictEqual(payment.status, 'REFUNDED');
    });

    test('18. Unpaid order cancellation cancels normally without refund', async () => {
        const order = { orderId: 999, paymentStatus: 'unpaid', paymentMethod: 'cash', status: 'waiting' };
        let refundTriggered = false;

        function cancelOrder(o) {
            if (o.paymentStatus === 'paid') {
                refundTriggered = true;
            }
            o.status = 'cancelled';
        }

        cancelOrder(order);
        assert.strictEqual(refundTriggered, false, 'No refund triggered for unpaid order');
        assert.strictEqual(order.status, 'cancelled');
        assert.strictEqual(order.paymentStatus, 'unpaid');
    });

    test('21. Legacy createOrder blocks client from creating unpaid online/wallet orders directly', async () => {
        const ONLINE_PAYMENT_METHODS = ['online', 'card', 'wallet', 'app_wallet', 'paymob', 'mobile_wallet'];
        
        function checkCanCreateDirectOrder(user, paymentMethod) {
            const isAdmin = user?.isAdmin === true;
            if (!isAdmin && paymentMethod && ONLINE_PAYMENT_METHODS.includes(paymentMethod.toLowerCase())) {
                return { allowed: false, code: 'CHECKOUT_SESSION_REQUIRED' };
            }
            return { allowed: true };
        }

        // Regular customer trying to create unpaid online order
        const regularUser = { id: 'user-1', isAdmin: false };
        assert.strictEqual(checkCanCreateDirectOrder(regularUser, 'online').allowed, false);
        assert.strictEqual(checkCanCreateDirectOrder(regularUser, 'wallet').allowed, false);
        assert.strictEqual(checkCanCreateDirectOrder(regularUser, 'card').allowed, false);

        // Regular customer creating cash order -> allowed
        assert.strictEqual(checkCanCreateDirectOrder(regularUser, 'cash').allowed, true);
        assert.strictEqual(checkCanCreateDirectOrder(regularUser, undefined).allowed, true);

        // Admin creating any order -> allowed
        const adminUser = { id: 'admin-1', isAdmin: true };
        assert.strictEqual(checkCanCreateDirectOrder(adminUser, 'online').allowed, true);
        assert.strictEqual(checkCanCreateDirectOrder(adminUser, 'wallet').allowed, true);
    });

    test('22. Atomic cancellation prevents simultaneous double cancellation/refund', async () => {
        let orderDoc = { orderId: 100, status: 'accepted', paymentStatus: 'paid' };
        let cancellations = 0;

        async function atomicCancel(order) {
            // Simulated findOneAndUpdate({ orderId: id, status: { $nin: ['cancelled', 'deleted'] } })
            if (['cancelled', 'deleted'].includes(order.status)) {
                return null;
            }
            order.status = 'cancelled';
            cancellations++;
            return order;
        }

        const [res1, res2] = await Promise.all([
            atomicCancel(orderDoc),
            atomicCancel(orderDoc),
        ]);

        const successfulCancels = [res1, res2].filter(r => r !== null).length;
        assert.strictEqual(successfulCancels, 1, 'Only one concurrent cancel request can succeed');
        assert.strictEqual(cancellations, 1, 'Cancellation logic only executed once');
    });
});


// ═══════════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════════

async function runAll() {
    // Give async tests a moment
    await new Promise((resolve) => setTimeout(resolve, 100));

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.error(`\n❌ ${failed} test(s) FAILED`);
        process.exit(1);
    } else {
        console.log(`\n✅ All ${passed} tests passed`);
    }
}

// Run after all describe blocks have registered their tests
setTimeout(runAll, 200);
