/**
 * routes/checkout.js
 * Routes for CheckoutSession (Strict Payment-Before-Order architecture).
 *
 * Endpoints:
 *   POST /api/checkout/session            → Create session with frozen snapshot
 *   GET  /api/checkout/:sessionId         → Query session details and status
 *   POST /api/checkout/:sessionId/pay-online → Initiate Paymob payment
 *   POST /api/checkout/:sessionId/pay-wallet → Pay from application wallet
 */

'use strict';

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/verifytoken');
const { rateLimit } = require('express-rate-limit');
const {
    createSession,
    getSession,
    payOnline,
    payWallet,
} = require('../payments/controllers/checkoutController');

const sessionCreationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      10,
    keyGenerator: (req) => req.user?.id || req.ip,
    handler: (req, res) => {
        res.status(429).json({
            success: false,
            code:    'TOO_MANY_REQUESTS',
            message: 'Too many checkout requests, please wait before trying again.',
        });
    },
    standardHeaders: true,
    legacyHeaders:   false,
});

const paymentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      5,
    keyGenerator: (req) => req.user?.id || req.ip,
    handler: (req, res) => {
        res.status(429).json({
            success: false,
            code:    'TOO_MANY_REQUESTS',
            message: 'Too many payment attempts, please wait before trying again.',
        });
    },
    standardHeaders: true,
    legacyHeaders:   false,
});

router.post('/session',                  verifyToken, sessionCreationLimiter, createSession);
router.get('/:sessionId',                verifyToken, getSession);
router.post('/:sessionId/pay-online',    verifyToken, paymentLimiter, payOnline);
router.post('/:sessionId/pay-wallet',    verifyToken, paymentLimiter, payWallet);

module.exports = router;
