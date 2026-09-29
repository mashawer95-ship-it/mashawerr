/**
 * payments/tests/fixtures/paymobCallbacks.js
 * Realistic sanitized Paymob callback fixtures for testing.
 *
 * All values are synthetic — no real secrets, no real card data.
 * The HMAC values in these fixtures are computed with the test HMAC secret:
 *   PAYMOB_HMAC_SECRET = 'test_hmac_secret_32_bytes_exactly!'
 *
 * Use these fixtures in integration tests to simulate Paymob webhook behavior.
 */

'use strict';

const crypto = require('crypto');

const TEST_HMAC_SECRET    = 'test_hmac_secret_32_bytes_exactly!';
const TEST_INTEGRATION_ID = 12345;

/**
 * Compute HMAC for a transaction object (matches paymob.hmac.js logic).
 */
function computeHmac(transaction) {
    const fields = [
        'amount_cents', 'created_at', 'currency', 'error_occured',
        'has_parent_transaction', 'id', 'integration_id', 'is_3d_secure',
        'is_auth', 'is_capture', 'is_indexed', 'is_standalone_payment',
        'is_voided', 'order.id', 'owner', 'pending',
        'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
    ];

    function get(obj, path) {
        const parts = path.split('.');
        let cur = obj;
        for (const p of parts) {
            if (cur == null) return '';
            cur = cur[p];
        }
        return cur == null ? '' : String(cur);
    }

    const concat = fields.map((f) => get(transaction, f)).join('');
    return crypto.createHmac('sha512', TEST_HMAC_SECRET).update(concat).digest('hex');
}

// ─── Base transaction template ────────────────────────────────────────────────

const baseTransaction = {
    id:                    99887766,
    created_at:            '2024-01-15T10:30:00.000000',
    currency:              'EGP',
    amount_cents:          5000,
    error_occured:         false,
    has_parent_transaction: false,
    integration_id:        TEST_INTEGRATION_ID,
    is_3d_secure:          false,
    is_auth:               false,
    is_capture:            false,
    is_indexed:            true,
    is_standalone_payment: true,
    is_voided:             false,
    owner:                 33221100,
    pending:               false,
    success:               true,
    order: {
        id: 77665544,
        merchant_order_id: null,
        special_reference: 'pay_507f1f77bcf86cd799439011',
    },
    source_data: {
        pan:      '2346',
        sub_type: 'MasterCard',
        type:     'card',
    },
    data: {
        message: null,
    },
    special_reference: 'pay_507f1f77bcf86cd799439011',
    extras: {
        payment_reference: 'pay_507f1f77bcf86cd799439011',
    },
};

// ─── Fixture 1: Successful transaction ───────────────────────────────────────

const successfulTransaction = { ...baseTransaction, success: true, pending: false };

const successfulCallbackBody = {
    obj:  successfulTransaction,
    type: 'TRANSACTION',
};

const successfulCallbackQuery = {
    hmac: computeHmac(successfulTransaction),
    type: 'TRANSACTION',
};

// ─── Fixture 2: Failed transaction ───────────────────────────────────────────

const failedTransaction = {
    ...baseTransaction,
    id:       99887767,
    success:  false,
    pending:  false,
    error_occured: true,
    data: { message: 'Insufficient funds' },
};

const failedCallbackBody = {
    obj:  failedTransaction,
    type: 'TRANSACTION',
};

const failedCallbackQuery = {
    hmac: computeHmac(failedTransaction),
    type: 'TRANSACTION',
};

// ─── Fixture 3: Pending transaction ──────────────────────────────────────────

const pendingTransaction = {
    ...baseTransaction,
    id:      99887768,
    success: false,
    pending: true,
};

const pendingCallbackBody  = { obj: pendingTransaction, type: 'TRANSACTION' };
const pendingCallbackQuery = { hmac: computeHmac(pendingTransaction), type: 'TRANSACTION' };

// ─── Fixture 4: Voided/refunded transaction ───────────────────────────────────

const refundedTransaction = {
    ...baseTransaction,
    id:         99887769,
    is_voided:  true,
    is_refunded: true,
    success:    false,
    pending:    false,
};

const refundedCallbackBody  = { obj: refundedTransaction, type: 'TRANSACTION' };
const refundedCallbackQuery = { hmac: computeHmac(refundedTransaction), type: 'TRANSACTION' };

// ─── Fixture 5: Invalid HMAC ──────────────────────────────────────────────────

const invalidHmacCallbackBody  = { obj: successfulTransaction, type: 'TRANSACTION' };
const invalidHmacCallbackQuery = { hmac: 'a'.repeat(128), type: 'TRANSACTION' };

// ─── Fixture 6: Amount mismatch (success=true but wrong amount) ───────────────

const amountMismatchTransaction = {
    ...baseTransaction,
    id:           99887770,
    amount_cents: 1,    // Tampered! Our stored payment is 5000 piastres
    success:      true,
    pending:      false,
};
const amountMismatchBody  = { obj: amountMismatchTransaction, type: 'TRANSACTION' };
const amountMismatchQuery = { hmac: computeHmac(amountMismatchTransaction), type: 'TRANSACTION' };

// ─── Fixture 7: Currency mismatch ────────────────────────────────────────────

const currencyMismatchTransaction = {
    ...baseTransaction,
    id:       99887771,
    currency: 'USD',   // Wrong currency
    success:  true,
    pending:  false,
};
const currencyMismatchBody  = { obj: currencyMismatchTransaction, type: 'TRANSACTION' };
const currencyMismatchQuery = { hmac: computeHmac(currencyMismatchTransaction), type: 'TRANSACTION' };

// ─── Fixture 8: Duplicate callback (same as successful) ──────────────────────

const duplicateCallbackBody  = { ...successfulCallbackBody };
const duplicateCallbackQuery = { ...successfulCallbackQuery };

// ─── Fixture 9: Wrong integration ID ─────────────────────────────────────────

const wrongIntegrationTransaction = {
    ...baseTransaction,
    id:             99887772,
    integration_id: 99999,   // Not our integration
    success:        true,
    pending:        false,
};
const wrongIntegrationBody  = { obj: wrongIntegrationTransaction, type: 'TRANSACTION' };
const wrongIntegrationQuery = { hmac: computeHmac(wrongIntegrationTransaction), type: 'TRANSACTION' };

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    TEST_HMAC_SECRET,
    TEST_INTEGRATION_ID,
    computeHmac,

    // Fixture 1: Success
    successfulCallbackBody,
    successfulCallbackQuery,

    // Fixture 2: Failed
    failedCallbackBody,
    failedCallbackQuery,

    // Fixture 3: Pending
    pendingCallbackBody,
    pendingCallbackQuery,

    // Fixture 4: Refunded
    refundedCallbackBody,
    refundedCallbackQuery,

    // Fixture 5: Invalid HMAC
    invalidHmacCallbackBody,
    invalidHmacCallbackQuery,

    // Fixture 6: Amount mismatch
    amountMismatchBody,
    amountMismatchQuery,

    // Fixture 7: Currency mismatch
    currencyMismatchBody,
    currencyMismatchQuery,

    // Fixture 8: Duplicate
    duplicateCallbackBody,
    duplicateCallbackQuery,

    // Fixture 9: Wrong integration
    wrongIntegrationBody,
    wrongIntegrationQuery,
};
