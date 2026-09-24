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

