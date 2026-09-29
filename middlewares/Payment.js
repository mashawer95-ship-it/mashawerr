/**
 * middlewares/Payment.js
 * Payment & PaymentEvent Mongoose models for Mashawerr API.
 *
 * v2 changes (payment-before-order + wallet top-up support):
 *  - orderId is now optional (no order exists before payment verification)
 *  - Added `purpose`: ORDER_PAYMENT | WALLET_TOPUP
 *  - Added `paymentMethod`: CARD | MOBILE_WALLET | APP_WALLET | CASH
 *  - Added `checkoutSessionId` for linking to checkout sessions
 *  - Added `walletId` for linking wallet top-ups to the wallet
 *  - Expanded PAYMENT_EVENT_TYPES for wallet and checkout events
 *  - All existing state machine transitions preserved
 *  - All existing indexes preserved + new ones added
 */

'use strict';

const mongoose = require('mongoose');

// ─── Payment Purpose ──────────────────────────────────────────────────────────
const PAYMENT_PURPOSES = Object.freeze([
    'ORDER_PAYMENT',  // Payment for a delivery/purchase order via Paymob
    'WALLET_TOPUP',   // Customer topping up their application wallet via Paymob
]);

// ─── Payment Method ───────────────────────────────────────────────────────────
const PAYMENT_METHODS = Object.freeze([
    'CARD',           // Paymob card (credit/debit/prepaid)
    'MOBILE_WALLET',  // Paymob mobile wallet (Vodafone Cash, etc.)
    'APPLE_PAY',      // Apple Pay through Paymob (requires separate integration ID)
    'APP_WALLET',     // Internal application wallet debit (does NOT go through Paymob)
    'CASH',           // Cash on delivery
]);

// ─── Payment Status Enum ──────────────────────────────────────────────────────
const PAYMENT_STATUSES = Object.freeze([
    'PENDING',
    'PAID',
    'FAILED',
    'CANCELLED',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
]);

// Legal state machine transitions
const PAYMENT_TRANSITIONS = Object.freeze({
    PENDING:            ['PAID', 'FAILED', 'CANCELLED'],
    PAID:               ['PARTIALLY_REFUNDED', 'REFUNDED'],
    PARTIALLY_REFUNDED: ['REFUNDED'],
    FAILED:             [],
    CANCELLED:          [],
    REFUNDED:           [],
});

// ─── Payment Event Types ──────────────────────────────────────────────────────
const PAYMENT_EVENT_TYPES = Object.freeze([
    // Core payment lifecycle
    'PAYMENT_CREATED',
    'PAYMENT_INTENTION_CREATED',
    'PAYMENT_WEBHOOK_RECEIVED',
    'PAYMENT_SUCCESS',
    'PAYMENT_FAILED',
    'PAYMENT_CANCELLED',
    // Security & idempotency
    'PAYMENT_DUPLICATE_CALLBACK',
    'PAYMENT_HMAC_FAILED',
    'PAYMENT_AMOUNT_MISMATCH',
    'PAYMENT_CURRENCY_MISMATCH',
    'PAYMENT_INTEGRATION_MISMATCH',
    'PAYMENT_PURPOSE_MISMATCH',
    'PAYMENT_SUSPICIOUS',
    // Refund lifecycle
    'PAYMENT_REFUND_REQUESTED',
    'PAYMENT_REFUND_SUCCEEDED',
    'PAYMENT_REFUND_FAILED',
    // Wallet top-up events
    'WALLET_TOPUP_CREATED',
    'WALLET_TOPUP_COMPLETED',
    'WALLET_TOPUP_FAILED',
    'WALLET_CREDIT',
    'WALLET_DEBIT',
    // Order creation events
    'ORDER_CREATED_AFTER_PAYMENT',
    'ORDER_PAYMENT_FROM_WALLET',
    // Checkout events
    'CHECKOUT_SESSION_CREATED',
    'CHECKOUT_SESSION_EXPIRED',
    'CHECKOUT_SESSION_COMPLETED',
    // Integrity
    'WALLET_INTEGRITY_ERROR',
    'RECONCILIATION_ALERT',
]);

// ─── Payment Schema ───────────────────────────────────────────────────────────
const PaymentSchema = new mongoose.Schema(
    {
        // ─── Identity ─────────────────────────────────────────────────────────

        /** ID of the user who initiated the payment (from JWT — never from request body) */
        userId: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },

        /**
         * Payment purpose — distinguishes ORDER_PAYMENT from WALLET_TOPUP.
         * Critical for routing webhook processing correctly.
         * A wallet top-up MUST NEVER accidentally create an Order.
         * An order payment MUST NEVER accidentally credit the wallet.
         */
        purpose: {
            type: String,
            enum: PAYMENT_PURPOSES,
            required: true,
            default: 'ORDER_PAYMENT',
        },

        /**
         * Payment method used (Paymob-specific or app wallet).
         * For Paymob payments, this reflects the integration used.
         */
        paymentMethod: {
            type: String,
            enum: PAYMENT_METHODS,
            default: 'CARD',
        },

        // ─── Order Linkage (ORDER_PAYMENT only) ───────────────────────────────

        /**
         * Internal MongoDB Order reference (_id of Order document).
         * Set ONLY after the final Order is created (post-webhook).
         * Optional: null during PENDING and PAID states before order creation.
         */
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            default: null,
            index: true,
        },

        /** Numeric human-readable order ID (Order.orderId) — denormalized */
        orderNumericId: {
            type: Number,
            default: null,
            index: true,
        },

        /**
         * CheckoutSession reference.
         * Required for ORDER_PAYMENT purpose payments.
         * null for WALLET_TOPUP.
         */
        checkoutSessionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'CheckoutSession',
            default: null,
            index: true,
        },

        // ─── Wallet Top-Up Linkage (WALLET_TOPUP only) ────────────────────────

        /**
         * Wallet document _id for wallet top-up payments.
         * null for ORDER_PAYMENT.
         */
        walletId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Wallet',
            default: null,
        },

        // ─── Provider Details ─────────────────────────────────────────────────

        /** Payment provider identifier */
        provider: {
            type: String,
            enum: ['paymob', 'app_wallet', 'cash'],
            required: true,
            default: 'paymob',
        },

        /** Paymob Intention ID */
        providerIntentionId: {
            type: String,
            trim: true,
            default: null,
        },

        /** Paymob internal order ID */
        providerOrderId: {
            type: String,
            trim: true,
            default: null,
        },

        /** Paymob transaction ID (set after webhook) */
        providerTransactionId: {
            type: String,
            trim: true,
            default: null,
        },

        /**
         * Internal correlation key sent to Paymob as special_reference.
         * Format: topup_<paymentId> | pay_<checkoutSessionId>
         */
        specialReference: {
            type: String,
            trim: true,
            index: true,
        },

        // ─── Amount ───────────────────────────────────────────────────────────

        /**
         * Authoritative amount in EGP piastres (integer minor units).
         * 1 EGP = 100 piastres. This is what we sent to Paymob.
         * NEVER overwritten with callback data.
         */
        amountPiastres: {
            type: Number,
            required: true,
            min: 1,
        },

        /** ISO currency code we sent to Paymob */
        currency: {
            type: String,
            required: true,
            default: 'EGP',
            trim: true,
        },

        /**
         * Paymob integration ID used.
         * Validated against callback to prevent cross-merchant attacks.
         * null for APP_WALLET payments (no Paymob).
         */
        integrationId: {
            type: Number,
            default: null,
        },

        // ─── Status ───────────────────────────────────────────────────────────

        status: {
            type: String,
            enum: PAYMENT_STATUSES,
            default: 'PENDING',
            required: true,
            index: true,
        },

        failureReason: {
            type: String,
            trim: true,
            default: null,
        },

        refundedAmountPiastres: {
            type: Number,
            default: 0,
            min: 0,
        },

        // ─── Timestamps ───────────────────────────────────────────────────────

        expiresAt: {
            type: Date,
            default: null,
        },

        paidAt: {
            type: Date,
            default: null,
        },

        failedAt: {
            type: Date,
            default: null,
        },

        refundedAt: {
            type: Date,
            default: null,
        },

        /**
         * Non-sensitive metadata (source type, etc.)
         * Do NOT store CVV, full PANs, or auth credentials.
         */
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },
    },
    { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Primary idempotency: same Paymob transaction cannot be processed twice
PaymentSchema.index(
    { provider: 1, providerTransactionId: 1 },
    { unique: true, sparse: true, name: 'uniq_provider_txn' }
);

// Look up by order
PaymentSchema.index({ orderId: 1, status: 1 });

// Look up by checkout session
PaymentSchema.index({ checkoutSessionId: 1, status: 1 });

// Look up by purpose + status (e.g. pending top-ups for a user)
PaymentSchema.index({ userId: 1, purpose: 1, status: 1 });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isLegalTransition(from, to) {
    const allowed = PAYMENT_TRANSITIONS[from];
    return Array.isArray(allowed) && allowed.includes(to);
}

// ─── PaymentEvent Schema (immutable audit log) ────────────────────────────────
const PaymentEventSchema = new mongoose.Schema(
    {
        paymentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Payment',
            required: true,
            index: true,
        },

        // orderId — optional (null for wallet top-ups, set after order creation)
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            default: null,
            index: true,
        },

        // checkoutSessionId — for checkout-related events
        checkoutSessionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'CheckoutSession',
            default: null,
        },

        eventType: {
            type: String,
            enum: PAYMENT_EVENT_TYPES,
            required: true,
        },

        provider: {
            type: String,
            enum: ['paymob', 'app_wallet', 'system'],
            default: 'system',
        },

        providerEventId: {
            type: String,
            trim: true,
            default: null,
        },

        // Safe sanitized snapshot — NEVER raw webhook body
        payloadSummary: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },

        requestId: {
            type: String,
            trim: true,
            default: null,
        },

        message: {
            type: String,
            trim: true,
            default: null,
        },
    },
    {
        timestamps: true,
        strict: true,
    }
);

PaymentEventSchema.index({ paymentId: 1, createdAt: -1 });

// ─── Models ───────────────────────────────────────────────────────────────────
const Payment = mongoose.model('Payment', PaymentSchema, 'payments');
const PaymentEvent = mongoose.model('PaymentEvent', PaymentEventSchema, 'payment_events');

module.exports = {
    Payment,
    PaymentEvent,
    PAYMENT_STATUSES,
    PAYMENT_TRANSITIONS,
    PAYMENT_EVENT_TYPES,
    PAYMENT_PURPOSES,
    PAYMENT_METHODS,
    isLegalTransition,
};
