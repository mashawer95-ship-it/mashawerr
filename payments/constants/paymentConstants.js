/**
 * payments/constants/paymentConstants.js
 * Single source of truth for all payment-domain constants.
 *
 * v2: Added wallet top-up limits, checkout expiry, wallet error codes.
 */

'use strict';

/** Supported payment provider keys */
const PAYMENT_PROVIDERS = Object.freeze({
    PAYMOB:     'paymob',
    APP_WALLET: 'app_wallet',
    CASH:       'cash',
});

/** Paymob API base URLs */
const PAYMOB_BASE_URL = Object.freeze({
    PRODUCTION: 'https://accept.paymob.com',
    // Paymob does not have a separate sandbox URL; use test credentials on the same URL.
    TEST: 'https://accept.paymob.com',
});

/** Currency we operate in for Paymob payments */
const CURRENCY = Object.freeze({
    EGP: 'EGP',
});

/**
 * Paymob endpoints.
 * Using the Intention API (current, recommended).
 * Refund endpoint: uses /api/acceptance/void_refund/refund with old auth token.
 * As documented at https://developers.paymob.com
 */
const PAYMOB_ENDPOINTS = Object.freeze({
    INTENTION: '/v1/intention/',
    REFUND:    '/api/acceptance/void_refund/refund',
    AUTH:      '/api/auth/tokens',  // Legacy auth — needed for refund API
});

/**
 * Paymob callback/webhook types in req.query.type.
 */
const PAYMOB_CALLBACK_TYPES = Object.freeze({
    TRANSACTION:     'TRANSACTION',
    DELIVERY_STATUS: 'DELIVERY_STATUS',
    TOKEN:           'TOKEN',
});

/**
 * How many piastres (integer minor units) are in 1 EGP.
 * Paymob calls this "amount_cents".
 */
const EGP_PIASTRES_PER_UNIT = 100;

/**
 * Fils-to-piastres conversion factor.
 * Project stores amounts as fils (1 EGP = 1000 fils).
 * Paymob expects piastres (1 EGP = 100 piastres).
 * Ratio: piastres = fils / 10
 */
const FILS_PER_PIASTRE = 10;

/**
 * HTTP timeout (ms) for Paymob API calls.
 */
const PAYMOB_HTTP_TIMEOUT_MS = 15_000;

/**
 * Duration (minutes) before a PENDING payment / checkout session expires.
 */
const PAYMENT_EXPIRY_MINUTES = 30;

/**
 * Duration (minutes) for a checkout session before it expires.
 * Slightly longer than payment expiry to allow for retry flows.
 */
const CHECKOUT_EXPIRY_MINUTES = 45;

// ─── Wallet Limits ────────────────────────────────────────────────────────────
// All limits configured in EGP (جنيه مصري) with internal storage in FILS (1 EGP = 1000 fils).
// Defaults can be overridden via environment variables.

/** Minimum wallet top-up amount. Default: 1 EGP (جنيه واحد مصري) */
const WALLET_MIN_TOPUP_EGP = parseFloat(process.env.WALLET_MIN_TOPUP_EGP || '1');
const WALLET_MIN_TOPUP_FILS = parseInt(
    process.env.WALLET_MIN_TOPUP_FILS || String(Math.round(WALLET_MIN_TOPUP_EGP * 1000)),
    10
);

/** Maximum wallet top-up amount per transaction. Default: 5000 EGP */
const WALLET_MAX_TOPUP_EGP = parseFloat(process.env.WALLET_MAX_TOPUP_EGP || '5000');
const WALLET_MAX_TOPUP_FILS = parseInt(
    process.env.WALLET_MAX_TOPUP_FILS || String(Math.round(WALLET_MAX_TOPUP_EGP * 1000)),
    10
);

/** Maximum wallet balance allowed. Default: 10000 EGP */
const WALLET_MAX_BALANCE_EGP = parseFloat(process.env.WALLET_MAX_BALANCE_EGP || '10000');
const WALLET_MAX_BALANCE_FILS = parseInt(
    process.env.WALLET_MAX_BALANCE_FILS || String(Math.round(WALLET_MAX_BALANCE_EGP * 1000)),
    10
);

/** Maximum daily top-up total per user. Default: 10000 EGP */
const WALLET_DAILY_TOPUP_LIMIT_EGP = parseFloat(process.env.WALLET_DAILY_TOPUP_LIMIT_EGP || '10000');
const WALLET_DAILY_TOPUP_LIMIT_FILS = parseInt(
    process.env.WALLET_DAILY_TOPUP_LIMIT_FILS || String(Math.round(WALLET_DAILY_TOPUP_LIMIT_EGP * 1000)),
    10
);

// ─── Error Codes ──────────────────────────────────────────────────────────────
const PAYMENT_ERROR_CODES = Object.freeze({
    // Payment
    PAYMENT_NOT_FOUND:             'PAYMENT_NOT_FOUND',
    PAYMENT_ALREADY_EXISTS:        'PAYMENT_ALREADY_EXISTS',
    PAYMENT_PROVIDER_ERROR:        'PAYMENT_PROVIDER_ERROR',
    PAYMENT_HMAC_INVALID:          'PAYMENT_HMAC_INVALID',
    PAYMENT_AMOUNT_MISMATCH:       'PAYMENT_AMOUNT_MISMATCH',
    PAYMENT_CURRENCY_MISMATCH:     'PAYMENT_CURRENCY_MISMATCH',
    PAYMENT_INTEGRATION_MISMATCH:  'PAYMENT_INTEGRATION_MISMATCH',
    PAYMENT_PURPOSE_MISMATCH:      'PAYMENT_PURPOSE_MISMATCH',
    PAYMENT_ALREADY_PROCESSED:     'PAYMENT_ALREADY_PROCESSED',
    PAYMENT_EXPIRED:               'PAYMENT_EXPIRED',
    PAYMENT_UNAUTHORIZED:          'PAYMENT_UNAUTHORIZED',
    PAYMENT_INVALID_TRANSITION:    'PAYMENT_INVALID_TRANSITION',
    PAYMENT_NOT_REFUNDABLE:        'PAYMENT_NOT_REFUNDABLE',
    PAYMENT_METHOD_UNAVAILABLE:    'PAYMENT_METHOD_UNAVAILABLE',
    // Order
    ORDER_NOT_FOUND:               'ORDER_NOT_FOUND',
    ORDER_NOT_PAYABLE:             'ORDER_NOT_PAYABLE',
    ORDER_ALREADY_PAID:            'ORDER_ALREADY_PAID',
    ORDER_ALREADY_CREATED:         'ORDER_ALREADY_CREATED',
    ORDER_NOT_VERIFIED:            'PAYMENT_NOT_VERIFIED',
    // Refund
    REFUND_AMOUNT_INVALID:         'REFUND_AMOUNT_INVALID',
    REFUND_EXCEEDS_PAID:           'REFUND_AMOUNT_EXCEEDED',
    REFUND_ALREADY_PENDING:        'REFUND_ALREADY_PENDING',
    // Checkout
    CHECKOUT_NOT_FOUND:            'CHECKOUT_NOT_FOUND',
    CHECKOUT_EXPIRED:              'CHECKOUT_EXPIRED',
    CHECKOUT_ALREADY_COMPLETED:    'CHECKOUT_ALREADY_COMPLETED',
    CHECKOUT_UNAUTHORIZED:         'CHECKOUT_UNAUTHORIZED',
    // Wallet
    WALLET_NOT_FOUND:              'WALLET_NOT_FOUND',
    WALLET_INSUFFICIENT_BALANCE:   'WALLET_INSUFFICIENT_BALANCE',
    WALLET_TOPUP_INVALID_AMOUNT:   'WALLET_TOPUP_INVALID_AMOUNT',
    WALLET_TOPUP_BELOW_MIN:        'WALLET_TOPUP_BELOW_MIN',
    WALLET_TOPUP_ABOVE_MAX:        'WALLET_TOPUP_ABOVE_MAX',
    WALLET_BALANCE_EXCEEDED:       'WALLET_BALANCE_EXCEEDED',
    WALLET_DAILY_LIMIT_EXCEEDED:   'WALLET_DAILY_LIMIT_EXCEEDED',
    WALLET_DEBIT_FAILED:           'WALLET_DEBIT_FAILED',
});

module.exports = {
    PAYMENT_PROVIDERS,
    PAYMOB_BASE_URL,
    CURRENCY,
    PAYMOB_ENDPOINTS,
    PAYMOB_CALLBACK_TYPES,
    EGP_PIASTRES_PER_UNIT,
    FILS_PER_PIASTRE,
    PAYMOB_HTTP_TIMEOUT_MS,
    PAYMENT_EXPIRY_MINUTES,
    CHECKOUT_EXPIRY_MINUTES,
    WALLET_MIN_TOPUP_EGP,
    WALLET_MIN_TOPUP_FILS,
    WALLET_MAX_TOPUP_EGP,
    WALLET_MAX_TOPUP_FILS,
    WALLET_MAX_BALANCE_EGP,
    WALLET_MAX_BALANCE_FILS,
    WALLET_DAILY_TOPUP_LIMIT_EGP,
    WALLET_DAILY_TOPUP_LIMIT_FILS,
    PAYMENT_ERROR_CODES,
};
