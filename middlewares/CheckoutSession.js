/**
 * middlewares/CheckoutSession.js
 * Checkout Session model — the payment-before-order gate.
 *
 * Architecture:
 *   Cart → CheckoutSession → Payment → [webhook] → FinalOrder
 *
 * A CheckoutSession captures a commercial snapshot at the moment the customer
 * proceeds to payment. It preserves:
 *  - Delivery fee (authoritative — validated server-side)
 *  - Full task/route data needed to create the final Order
 *  - Discount snapshot
 *  - Payment method intent
 *
 * The final Order is created ONLY after a verified Paymob webhook (or
 * after a successful atomic wallet debit). Never before.
 *
 * One CheckoutSession → at most one final Order (enforced by unique index).
 */

'use strict';

const mongoose = require('mongoose');

// ─── Session Statuses ─────────────────────────────────────────────────────────
const CHECKOUT_STATUSES = Object.freeze([
    'PENDING',      // Created, awaiting payment
    'PAYMENT_PENDING', // Paymob intention created, customer in checkout
    'PAID',         // Payment verified — proceeding to order creation
    'COMPLETED',    // Final Order created and linked
    'FAILED',       // Payment failed
    'EXPIRED',      // Expired without payment
    'CANCELLED',    // Cancelled by user before payment
]);

// ─── Payment Method Intents ───────────────────────────────────────────────────
const CHECKOUT_PAYMENT_METHODS = Object.freeze([
    'CARD',          // Paymob card payment
    'MOBILE_WALLET', // Paymob mobile wallet (Vodafone Cash, etc.)
    'APP_WALLET',    // Internal application wallet
    'CASH',          // Cash on delivery (no Paymob)
]);

// ─── Schema ───────────────────────────────────────────────────────────────────
const CheckoutSessionSchema = new mongoose.Schema(
    {
        /** The customer creating this session (from JWT) */
        userId: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },

        /** Current session status */
        status: {
            type: String,
            enum: CHECKOUT_STATUSES,
            default: 'PENDING',
            required: true,
            index: true,
        },

        /**
         * Intended payment method — set by client, validated server-side.
         * APP_WALLET sessions bypass Paymob entirely.
         */
        paymentMethod: {
            type: String,
            enum: CHECKOUT_PAYMENT_METHODS,
            required: true,
            default: 'CARD',
        },

        // ─── Commercial Snapshot ──────────────────────────────────────────────
        // Captured at checkout time. These values are FROZEN — they are what
        // the customer agreed to pay and what the final Order will use.

        /**
         * Delivery fee in fils (integer) AFTER discounts.
         * This is the authoritative amount sent to Paymob or debited from wallet.
         * Server-validated — never trusted from client.
         */
        totalDeliveryPriceFils: {
            type: Number,
            required: true,
            min: 0,
        },

        /** Original delivery fee before discounts (fils) */
        originalDeliveryPriceFils: {
            type: Number,
            default: null,
        },

        /** Discount amount applied (fils) */
        discountAmountFils: {
            type: Number,
            default: 0,
        },

        /** Discount code used, if any */
        discountCode: {
            type: String,
            trim: true,
            default: null,
        },

        /** Discount type (percentage / fixed / user_discount) */
        discountType: {
            type: String,
            trim: true,
            default: null,
        },

        /** Discount percentage (0-100), if applicable */
        discountPercentage: {
            type: Number,
            default: null,
        },

        /**
         * Full snapshot of the order payload exactly as the client submitted
         * and server validated. Used verbatim when creating the final Order
         * after payment verification.
         *
         * This snapshot freezes: tasks, addresses, vehicle, route data, pricing,
         * orderCategory, paymentMethod, etc.
         *
         * Critical: this snapshot must be complete enough to create the Order
         * without any additional client data.
         */
        orderSnapshot: {
            type: mongoose.Schema.Types.Mixed,
            required: true,
        },

        /** Vehicle type ID from the snapshot (denormalized for quick access) */
        vehicleTypeId: {
            type: String,
            trim: true,
            default: null,
        },

        /** Order category (delivery / purchase / passenger) */
        orderCategory: {
            type: String,
            enum: ['delivery', 'purchase', 'passenger'],
            default: 'delivery',
        },

        /** Governorate from the snapshot */
        governorate: {
            type: String,
            trim: true,
            default: null,
        },

        // ─── Payment Linkage ──────────────────────────────────────────────────

        /**
         * Payment document _id created for this session.
         * Set when Paymob intention is created or wallet debit is initiated.
         */
        paymentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Payment',
            default: null,
            index: true,
        },

        /** Paymob's own intention ID (echoed for debugging) */
        providerIntentionId: {
            type: String,
            trim: true,
            default: null,
        },

        // ─── Order Linkage ────────────────────────────────────────────────────

        /**
         * Final Order _id created after payment verification.
         * Unique sparse — one session creates at most one Order.
         */
        finalOrderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            default: null,
        },

        /** Numeric orderId of the created Order (for display) */
        finalOrderNumericId: {
            type: Number,
            default: null,
        },

        // ─── Lifecycle timestamps ─────────────────────────────────────────────

        /** When checkout expires — client has until this time to pay */
        expiresAt: {
            type: Date,
            required: true,
            index: true,
        },

        /** When session transitioned to PAID */
        paidAt: {
            type: Date,
            default: null,
        },

        /** When final Order was created */
        completedAt: {
            type: Date,
            default: null,
        },

        /** When session was cancelled */
        cancelledAt: {
            type: Date,
            default: null,
        },

        /** Cancellation reason */
        cancellationReason: {
            type: String,
            trim: true,
            default: null,
        },
    },
    { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// One session → at most one final Order
CheckoutSessionSchema.index(
    { finalOrderId: 1 },
    {
        unique: true,
        partialFilterExpression: {
            finalOrderId: { $type: 'objectId' },
        },
        name: 'uniq_session_order_v2',
    }
);

// One PENDING/PAYMENT_PENDING session per user (prevents duplicate checkouts)
// Not unique — we may allow multiple expired sessions, but enforce in service logic
CheckoutSessionSchema.index({ userId: 1, status: 1 });

// Look up by paymentId
CheckoutSessionSchema.index({ paymentId: 1 }, { sparse: true });

const CheckoutSession = mongoose.model(
    'CheckoutSession',
    CheckoutSessionSchema,
    'checkout_sessions'
);

module.exports = {
    CheckoutSession,
    CHECKOUT_STATUSES,
    CHECKOUT_PAYMENT_METHODS,
};
