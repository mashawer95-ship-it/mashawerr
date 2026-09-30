/**
 * payments/controllers/checkoutController.js
 * Controller for CheckoutSession operations:
 *   - Create checkout session (commercial freeze)
 *   - Query checkout session
 *   - Initiate online Paymob payment from session
 *   - Pay order directly from wallet
 */

'use strict';

const asyncHandler = require('express-async-handler');
const checkoutService = require('../services/checkoutService');
const walletPaymentService = require('../services/walletPaymentService');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');

/**
 * POST /api/checkout/session
 * Creates a checkout session freezing the commercial snapshot.
 */
const createSession = asyncHandler(async (req, res) => {
    const requestId = req.id;
    const userId = req.user?.id || req.user?._id;

    if (!userId) {
        throw ApiError.unauthorized('المستخدم غير مسجل الدخول');
    }

    logger.info('[CheckoutController] createSession requested', {
        requestId,
        userId,
    });

    const result = await checkoutService.createCheckoutSession({
        userId,
        orderPayload: req.body,
        requestId,
    });

    return res.status(201).json({
        success: true,
        data: result,
    });
});

/**
 * GET /api/checkout/:sessionId
 * Get checkout session details.
 */
const getSession = asyncHandler(async (req, res) => {
    const userId = req.user?.id || req.user?._id;
    const { sessionId } = req.params;

    if (!userId) {
        throw ApiError.unauthorized('المستخدم غير مسجل الدخول');
    }

    const session = await checkoutService.getCheckoutSession({
        sessionId,
        userId,
    });

    return res.status(200).json({
        success: true,
        data: session,
    });
});

/**
 * POST /api/checkout/:sessionId/pay-online
 * Initiate Paymob payment for a checkout session.
 */
const payOnline = asyncHandler(async (req, res) => {
    const requestId = req.id;
    const userId = req.user?.id || req.user?._id;
    const { sessionId } = req.params;
    const paymentMethod = req.body?.paymentMethod || 'CARD';

    if (!userId) {
        throw ApiError.unauthorized('المستخدم غير مسجل الدخول');
    }

    logger.info('[CheckoutController] payOnline requested', {
        requestId,
        sessionId,
        userId,
        paymentMethod,
    });

    const result = await checkoutService.payCheckoutSessionOnline({
        sessionId,
        userId,
        paymentMethod,
        requestId,
    });

    return res.status(200).json({
        success: true,
        data: result,
    });
});

/**
 * POST /api/checkout/:sessionId/pay-wallet
 * Pay directly from customer internal wallet (atomic debit + order creation).
 */
const payWallet = asyncHandler(async (req, res) => {
    const requestId = req.id;
    const userId = req.user?.id || req.user?._id;
    const { sessionId } = req.params;

    if (!userId) {
        throw ApiError.unauthorized('المستخدم غير مسجل الدخول');
    }

    logger.info('[CheckoutController] payWallet requested', {
        requestId,
        sessionId,
        userId,
    });

    const result = await walletPaymentService.payOrderFromWallet({
        checkoutSessionId: sessionId,
        userId,
        requestId,
    });

    return res.status(200).json({
        success: true,
        data: result,
    });
});

/**
 * POST /api/checkout/:sessionId/confirm-cash
 * Confirm Cash payment for a checkout session and create the final order.
 */
const confirmCash = asyncHandler(async (req, res) => {
    const requestId = req.id;
    const userId = req.user?.id || req.user?._id;
    const { sessionId } = req.params;

    if (!userId) {
        throw ApiError.unauthorized('المستخدم غير مسجل الدخول');
    }

    logger.info('[CheckoutController] confirmCash requested', {
        requestId,
        sessionId,
        userId,
    });

    const result = await checkoutService.confirmCashCheckoutSession({
        sessionId,
        userId,
        requestId,
    });

    return res.status(200).json({
        success: true,
        data: result,
    });
});

module.exports = {
    createSession,
    getSession,
    payOnline,
    payWallet,
    confirmCash,
};
