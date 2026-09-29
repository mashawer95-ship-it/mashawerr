/**
 * routes/payments.js
 * Payment module routes — integrated into the existing Mashawerr API router pattern.
 *
 * Route summary:
 *
 *   POST   /api/orders/:orderId/payment          → Create payment intention (authenticated)
 *   GET    /api/orders/:orderId/payment-status   → Get payment status (authenticated)
 *   POST   /api/payments/paymob/webhook          → Paymob callback (no auth — HMAC protected)
 *   GET    /api/payments/paymob/redirect         → Post-checkout redirect page
 *   POST   /api/payments/:paymentId/refund       → Refund (admin only)
 */

'use strict';

const express = require('express');
const { authenticate }  = require('../middlewares/verifytoken');
const { authorize }     = require('../middlewares/authorize');
const { rateLimit }     = require('express-rate-limit');
const {
    createPayment,
    paymobWebhook,
    paymobRedirect,
    getPaymentStatus,
    refundPayment,
} = require('../payments/controllers/paymentController');

// ─── Order-scoped payment routes ─────────────────────────────────────────────

const orderPaymentRouter = express.Router({ mergeParams: true });

/**
 * POST /api/orders/:orderId/payment
 * Creates a Paymob payment intention for an existing order.
 *
 * Rate limit: 5 requests per minute per user — prevents rapid double-clicks.
 */
const paymentCreationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      5,
    keyGenerator: (req) => req.user?.id || req.ip,
    handler: (req, res) => {
        res.status(429).json({
            success: false,
            code:    'TOO_MANY_REQUESTS',
            message: 'Too many payment requests, please wait before trying again.',
        });
    },
    standardHeaders: true,
    legacyHeaders:   false,
});

orderPaymentRouter.post('/',        authenticate, paymentCreationLimiter, createPayment);
orderPaymentRouter.get('/status',   authenticate, getPaymentStatus);

// ─── Standalone payment routes ────────────────────────────────────────────────

const paymentsRouter = express.Router();

/**
 * POST /api/payments/paymob/webhook
 * Unauthenticated — Paymob callback.
 * Security is via HMAC (verified inside the controller before any processing).
 *
 * Rate limit: 120/min per IP — generous for Paymob retries, strict against abuse.
 */
const webhookRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max:      120,
    keyGenerator: (req) => req.ip,
    handler: (req, res) => {
        res.status(429).json({ success: false, message: 'Too many webhook requests' });
    },
    standardHeaders: true,
    legacyHeaders:   false,
});

// Webhook endpoints (supports both /paymob/webhook and /webhook)
paymentsRouter.post('/paymob/webhook',  webhookRateLimiter, paymobWebhook);
paymentsRouter.post('/webhook',         webhookRateLimiter, paymobWebhook);

// Redirect endpoints (supports /paymob/redirect, /redirect, and /callback)
paymentsRouter.get('/paymob/redirect',  paymobRedirect);
paymentsRouter.get('/redirect',         paymobRedirect);
paymentsRouter.get('/callback',         paymobRedirect);

/**
 * POST /api/payments/:paymentId/refund
 * Admin only. Requires admin or administration role.
 */
paymentsRouter.post('/:paymentId/refund', authenticate, authorize('admin', 'administration'), refundPayment);

module.exports = {
    orderPaymentRouter,
    paymentsRouter,
};
