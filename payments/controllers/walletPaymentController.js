/**
 * payments/controllers/walletPaymentController.js
 * Customer-facing controller for wallet operations:
 *  - Top-up via Paymob
 *  - Top-up status check
 *  - Ledger transaction history (Phase 6)
 *  - Customer balance query
 */

'use strict';

const asyncHandler = require('express-async-handler');
const walletPaymentService = require('../services/walletPaymentService');
const { validateWalletTopupRequest } = require('../validators/paymentValidators');
const { Payment } = require('../../middlewares/Payment');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const { PAYMENT_ERROR_CODES } = require('../constants/paymentConstants');

/**
 * POST /api/wallet/topup
 * Initiates a wallet top-up through Paymob.
 * Customer receives a clientSecret to complete payment in mobile app / SDK.
 */
const initiateTopup = asyncHandler(async (req, res) => {
    const requestId = req.id;
    const userId = req.user?.id || req.user?._id;

    if (!userId) {
        throw ApiError.unauthorized('المستخدم غير مسجل الدخول');
    }

    const { error, value } = validateWalletTopupRequest(req.body);
    if (error) {
        throw ApiError.badRequest(
            error.details.map((d) => d.message).join('; '),
            'VALIDATION_ERROR'
        );
    }

    let amountFils = value.amountFils;
    if (!amountFils && (value.amountEgp || value.amount)) {
        const { egpToFils } = require('../utils/money');
        amountFils = egpToFils(value.amountEgp || value.amount);
    }

    const paymentMethod = value.paymentMethod;
    const walletPhoneNumber = value.walletPhoneNumber || value.mobileNumber || value.phone;

    logger.info('[WalletPaymentController] initiateTopup requested', {
        requestId,
        userId,
        amountFils,
        paymentMethod,
    });

    const result = await walletPaymentService.createWalletTopupPayment({
        userId,
        amountFils,
        paymentMethod,
        walletPhoneNumber,
        requestId,
    });

    return res.status(200).json({
        success: true,
        data: {
            paymentId:     result.paymentId,
            status:        result.status,
            clientSecret:  result.clientSecret,
            checkoutUrl:   result.checkoutUrl,
            publicKey:     result.publicKey,
            expiresAt:     result.expiresAt,
            amountFils:    result.amountFils,
            amountEgp:     result.amountEgp,
            paymentMethod: result.paymentMethod,
        },
    });
});

/**
 * GET /api/wallet/topup/:paymentId/status
 * Get the current status of a top-up payment.
 */
const getTopupStatus = asyncHandler(async (req, res) => {
    const requestId = req.id;
    const { paymentId } = req.params;
    const userId = req.user?.id || req.user?._id;

    if (!userId) {
        throw ApiError.unauthorized('المستخدم غير مسجل الدخول');
    }

    const payment = await Payment.findById(paymentId).lean();
    if (!payment || payment.purpose !== 'WALLET_TOPUP') {
        throw ApiError.notFound('سجل الشحن غير موجود', PAYMENT_ERROR_CODES.PAYMENT_NOT_FOUND);
    }

    // Authorization: User must own the payment or be admin
    const isAdmin = req.user?.isAdmin === true || req.user?.role === 'admin';
    if (String(payment.userId) !== String(userId) && !isAdmin) {
        throw ApiError.forbidden('غير مسموح بالوصول', PAYMENT_ERROR_CODES.PAYMENT_UNAUTHORIZED);
    }

    const { filsToEgp } = require('../utils/money');
    const amountFils = (payment.amountPiastres || 0) * 10;

    return res.status(200).json({
        success: true,
        data: {
            paymentId:     payment._id,
            status:        payment.status,
            amountFils,
            amountEgp:     filsToEgp(amountFils),
            paidAt:        payment.paidAt,
            failedAt:      payment.failedAt,
            failureReason: payment.failureReason,
            expiresAt:     payment.expiresAt,
            createdAt:     payment.createdAt,
        },
    });
});

/**
 * GET /api/wallet/ledger/transactions
 * Customer-facing immutable ledger transactions (Phase 6).
 */
const getCustomerLedgerTransactions = asyncHandler(async (req, res) => {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
        throw ApiError.unauthorized('المستخدم غير مسجل الدخول');
    }

    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const result = await walletPaymentService.getWalletTransactions({
        userId,
        page,
        limit,
    });

    return res.status(200).json({
        success: true,
        data: result,
    });
});

/**
 * GET /api/wallet/balance/me
 * Customer wallet balance query.
 */
const getCustomerWalletBalance = asyncHandler(async (req, res) => {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
        throw ApiError.unauthorized('المستخدم غير مسجل الدخول');
    }

    const balance = await walletPaymentService.getWalletBalance(userId);

    return res.status(200).json({
        success: true,
        data: balance,
    });
});

module.exports = {
    initiateTopup,
    getTopupStatus,
    getCustomerLedgerTransactions,
    getCustomerWalletBalance,
};
