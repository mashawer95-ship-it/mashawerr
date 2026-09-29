const express = require('express');
const router = express.Router();
const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');
const {
    getAllWallets,
    getWallet,
    getTransactions,
    creditUserWallet,
    debitUserWallet,
    checkCanOrderEndpoint,
} = require('../Controllers/walletController');

// ── Admin: view all wallets ────────────────────────────────────────────────────
// GET /api/wallet/admin/all?page=1&limit=20&search=&userType=Representative
router.get('/admin/all', verifyTokenAndAdmin, getAllWallets);

// ── Check if authenticated user can order ──────────────────────────────────────
// GET /api/wallet/check-can-order
router.get('/check-can-order', verifyToken, checkCanOrderEndpoint);

// ── Customer Wallet Payment & Top-Up Endpoints (Phases 2 & 6) ──────────────────
const {
    initiateTopup,
    getTopupStatus,
    getCustomerLedgerTransactions,
    getCustomerWalletBalance,
} = require('../payments/controllers/walletPaymentController');
const { rateLimit } = require('express-rate-limit');

const topupLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      5,
    keyGenerator: (req) => req.user?.id || req.ip,
    handler: (req, res) => {
        res.status(429).json({
            success: false,
            code:    'TOO_MANY_REQUESTS',
            message: 'Too many topup requests, please wait before trying again.',
        });
    },
    standardHeaders: true,
    legacyHeaders:   false,
});

// POST /api/wallet/topup                      → initiate Paymob top-up intention
router.post('/topup', verifyToken, topupLimiter, initiateTopup);

// GET  /api/wallet/topup/:paymentId/status    → check status of top-up payment
router.get('/topup/:paymentId/status', verifyToken, getTopupStatus);

// GET  /api/wallet/ledger/transactions        → customer immutable ledger history
router.get('/ledger/transactions', verifyToken, getCustomerLedgerTransactions);

// GET  /api/wallet/balance/me                 → authenticated customer balance
router.get('/balance/me', verifyToken, getCustomerWalletBalance);

// ── Get wallet + last 50 tx ───────────────────────────────────────────────────
// GET /api/wallet/:userId
router.get('/:userId', verifyToken, getWallet);

// ── Paginated + filtered transactions ────────────────────────────────────────
// GET /api/wallet/:userId/transactions?page=1&limit=50&type=target_reward&startDate=&endDate=
router.get('/:userId/transactions', verifyToken, getTransactions);

// ── Admin: credit / debit ─────────────────────────────────────────────────────
// POST /api/wallet/:userId/credit   body: { amountFils, description }
// POST /api/wallet/:userId/debit    body: { amountFils, description }
router.post('/:userId/credit', verifyTokenAndAdmin, creditUserWallet);
router.post('/:userId/debit',  verifyTokenAndAdmin, debitUserWallet);

module.exports = router;

