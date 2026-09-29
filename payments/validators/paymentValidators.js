/**
 * payments/validators/paymentValidators.js
 * Joi validation schemas for payment endpoints.
 * Consistent with the project's existing Joi validation pattern.
 */

'use strict';

const joi = require('joi');

/**
 * Validate POST /api/orders/:orderId/payment route params.
 * orderId must be a valid MongoDB ObjectId.
 */
function validateCreatePaymentParams(params) {
    const schema = joi.object({
        orderId: joi.string().trim().length(24).pattern(/^[0-9a-fA-F]{24}$/).required().messages({
            'any.required':        'orderId is required',
            'string.length':       'orderId must be a 24-character MongoDB ObjectId',
            'string.pattern.base': 'orderId must be a valid MongoDB ObjectId',
        }),
    });
    return schema.validate(params, { abortEarly: false });
}

/**
 * Validate the Paymob webhook query parameters.
 * Paymob sends ?hmac=<value>&type=<TRANSACTION|TOKEN>
 */
function validateWebhookQuery(query) {
    const schema = joi.object({
        hmac: joi.string().trim().min(1).required().messages({
            'any.required': 'hmac query parameter is required',
            'string.empty': 'hmac must not be empty',
        }),
        type: joi.string().trim().valid('TRANSACTION', 'TOKEN', 'DELIVERY_STATUS').default('TRANSACTION'),
    }).unknown(true); // Paymob may send additional query params
    return schema.validate(query, { abortEarly: false });
}

/**
 * Validate the Paymob TRANSACTION callback body structure.
 * Uses loose validation — we trust HMAC, not field presence, for security.
 * This catches obviously malformed payloads before processing.
 */
function validateTransactionCallback(body) {
    const schema = joi.object({
        obj: joi.object({
            id:             joi.alternatives().try(joi.number(), joi.string()).required(),
            amount_cents:   joi.number().required(),
            currency:       joi.string().required(),
            success:        joi.boolean().required(),
            pending:        joi.boolean().required(),
            integration_id: joi.number().required(),
            order:          joi.object({
                id: joi.alternatives().try(joi.number(), joi.string()),
            }).unknown(true).required(),
            source_data: joi.object({
                type:     joi.string().allow('', null),
                sub_type: joi.string().allow('', null),
                pan:      joi.string().allow('', null),
            }).unknown(true),
        }).unknown(true).required(),
    }).unknown(true).required();

    return schema.validate(body, { abortEarly: false });
}

/**
 * Validate POST /api/payments/:paymentId/refund request body.
 */
function validateRefundRequest(body) {
    const schema = joi.object({
        // amount is optional — null/omitted means full refund
        amount: joi.number().integer().min(1).allow(null).optional().messages({
            'number.integer': 'amount must be an integer (piastres)',
            'number.min':     'amount must be at least 1 piastre',
        }),
        reason: joi.string().trim().max(500).allow('', null).optional(),
    });
    return schema.validate(body, { abortEarly: false });
}

/**
 * Validate POST /api/wallet/topup request body.
 */
function validateWalletTopupRequest(body) {
    const schema = joi.object({
        amountFils: joi.number().integer().min(1).required().messages({
            'any.required':   'amountFils is required',
            'number.base':    'amountFils must be a number',
            'number.integer': 'amountFils must be an integer (fils)',
            'number.min':     'amountFils must be at least 1 fil',
        }),
    });
    return schema.validate(body, { abortEarly: false });
}

module.exports = {
    validateCreatePaymentParams,
    validateWebhookQuery,
    validateTransactionCallback,
    validateRefundRequest,
    validateWalletTopupRequest,
};

