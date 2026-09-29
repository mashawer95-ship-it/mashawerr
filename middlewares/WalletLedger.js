/**
 * middlewares/WalletLedger.js
 * Immutable wallet transaction ledger — separate collection from the embedded Wallet.transactions.
 *
 * Design rationale:
 *  - The existing Wallet.transactions is an embedded array used for rep commissions, earnings, etc.
 *  - This new WalletLedger model is a dedicated collection for CUSTOMER-facing money movements:
 *    Paymob top-ups, order payments from wallet, refunds to wallet.
 *  - It is APPEND-ONLY. Never update historical records.
 *  - Balance is maintained on the parent Wallet.balanceFils — this ledger is the audit trail.
 *  - All monetary amounts are in FILS (integer). 1 EGP = 1000 fils.
 */

'use strict';

const mongoose = require('mongoose');

// ─── Ledger Entry Types ───────────────────────────────────────────────────────
const WALLET_TX_TYPES = Object.freeze(['CREDIT', 'DEBIT']);

// ─── Ledger Entry Sources ─────────────────────────────────────────────────────
const WALLET_TX_SOURCES = Object.freeze([
    'PAYMOB_TOPUP',      // Customer topped up via Paymob card/wallet
    'ORDER_PAYMENT',     // Customer paid an order from wallet
    'ORDER_REFUND',      // Refund after cancelled paid order
    'ADMIN_ADJUSTMENT',  // Admin manual credit or debit
    'OTHER',
]);

// ─── Ledger Entry Status ──────────────────────────────────────────────────────
const WALLET_TX_STATUSES = Object.freeze(['COMPLETED', 'PENDING', 'FAILED', 'REVERSED']);

// ─── Schema ───────────────────────────────────────────────────────────────────
const WalletLedgerSchema = new mongoose.Schema(
    {
        /** Reference to the user's Wallet document */
        walletId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Wallet',
            required: true,
            index: true,
        },

        /** User ID — denormalized for fast per-user queries without joining Wallet */
        userId: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },

        /** CREDIT = money added, DEBIT = money removed */
        type: {
            type: String,
            enum: WALLET_TX_TYPES,
            required: true,
        },

        /** Business reason for this transaction */
        source: {
            type: String,
            enum: WALLET_TX_SOURCES,
            required: true,
        },

        /**
         * Amount in fils (integer). Always positive.
         * Sign is determined by `type` (CREDIT or DEBIT).
         */
        amountFils: {
            type: Number,
            required: true,
            min: 1,
        },

        /** Currency for this ledger entry */
        currency: {
            type: String,
            default: 'EGP',
            trim: true,
        },

        /**
         * Wallet.balanceFils BEFORE this transaction.
         * Stored at insert time for reconciliation.
         * Must not be updated after creation.
         */
        balanceBeforeFils: {
            type: Number,
            required: true,
        },

        /**
         * Wallet.balanceFils AFTER this transaction.
         * Must satisfy: balanceAfterFils = balanceBeforeFils ± amountFils.
         */
        balanceAfterFils: {
            type: Number,
            required: true,
        },

        /** Transaction completion status */
        status: {
            type: String,
            enum: WALLET_TX_STATUSES,
            default: 'COMPLETED',
            required: true,
        },

        /**
         * Reference to the Payment document (_id) that caused this ledger entry.
         * Set for PAYMOB_TOPUP and ORDER_PAYMENT sources.
         */
        paymentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Payment',
            default: null,
            index: true,
        },

        /**
         * Reference to the Order document (_id).
         * Set for ORDER_PAYMENT and ORDER_REFUND sources.
         */
        orderId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Order',
            default: null,
            index: true,
        },

        /**
         * Reference to the CheckoutSession (_id).
         * Set during checkout-from-wallet flows.
         */
        checkoutSessionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'CheckoutSession',
            default: null,
        },

        /**
         * Paymob transaction ID — echoed from webhook for PAYMOB_TOPUP.
         * Sparse unique index prevents double-credit for same Paymob transaction.
         */
        providerTransactionId: {
            type: String,
            trim: true,
            default: null,
        },

        /**
         * Stable unique idempotency reference.
         * Format examples:
         *   TOPUP_<paymentId>
         *   ORDER_PAY_<checkoutSessionId>
         *   ORDER_REFUND_<orderId>_<timestamp>
         *   ADMIN_<adminId>_<timestamp>
         */
        reference: {
            type: String,
            trim: true,
            unique: true,
            sparse: true,
        },

        /** Safe human-readable description */
        description: {
            type: String,
            trim: true,
            default: '',
        },

        /**
         * Non-sensitive metadata.
         * Do NOT store CVV, PAN, or secrets here.
         */
        metadata: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },

        /** Who performed this action (userId string or 'system' or 'admin:<adminId>') */
        performedBy: {
            type: String,
            trim: true,
            default: 'system',
        },
    },
    {
        timestamps: true,
        strict: true,
    }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Unique constraint: same Paymob transaction cannot credit wallet twice
WalletLedgerSchema.index(
    { providerTransactionId: 1 },
    { unique: true, sparse: true, name: 'uniq_wallet_provider_txn' }
);

// Unique constraint on reference for general idempotency
WalletLedgerSchema.index(
    { reference: 1 },
    { unique: true, sparse: true, name: 'uniq_wallet_reference' }
);

// Fast per-user history queries
WalletLedgerSchema.index({ userId: 1, createdAt: -1 });
WalletLedgerSchema.index({ walletId: 1, createdAt: -1 });

const WalletLedger = mongoose.model('WalletLedger', WalletLedgerSchema, 'wallet_ledger');

module.exports = {
    WalletLedger,
    WALLET_TX_TYPES,
    WALLET_TX_SOURCES,
    WALLET_TX_STATUSES,
};
