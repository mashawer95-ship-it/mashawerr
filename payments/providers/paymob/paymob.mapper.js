/**
 * payments/providers/paymob/paymob.mapper.js
 * Maps between internal domain objects and Paymob API request/response shapes.
 *
 * Keeps the Paymob-specific data format isolated from our business logic.
 * If Paymob changes their API schema, only this file needs updating.
 */

'use strict';

const paymobConfig = require('../../config/paymobConfig');
const { PAYMENT_EXPIRY_MINUTES } = require('../../constants/paymentConstants');

/**
 * Build the Paymob Intention API request body.
 *
 * Paymob Intention v1 API:
 *   POST https://accept.paymob.com/v1/intention/
 *   Authorization: Token <SECRET_KEY>
 *
 * @param {object} params
 * @param {number}  params.amountPiastres   - Integer EGP piastres
 * @param {string}  params.specialReference - Our internal payment ref
 * @param {object}  params.billingData      - Customer billing info
 * @param {string}  params.notificationUrl  - Webhook URL for callbacks
 * @param {string}  params.redirectionUrl   - URL after customer completes checkout
 * @param {object}  [params.extras]         - Extra key-value data echoed in callback
 * @returns {object} Paymob intention request body
 */
function buildIntentionPayload({
    amountPiastres,
    specialReference,
    billingData,
    notificationUrl,
    redirectionUrl,
    extras = {},
    items,
    paymentMethod = 'ALL',
}) {
    const paymentMethods = [];
    const normPm = String(paymentMethod || '').toUpperCase().trim();

    if (normPm === 'MOBILE_WALLET' || normPm === 'WALLET' || normPm === 'CASH') {
        if (paymobConfig.walletIntegrationId) {
            paymentMethods.push(Number(paymobConfig.walletIntegrationId));
        } else if (Array.isArray(paymobConfig.integrationIds) && paymobConfig.integrationIds.length > 0) {
            paymentMethods.push(...paymobConfig.integrationIds);
        }
    } else if (normPm === 'CARD' || normPm === 'VISA') {
        if (paymobConfig.cardIntegrationId) {
            paymentMethods.push(Number(paymobConfig.cardIntegrationId));
        } else if (paymobConfig.integrationId) {
            paymentMethods.push(Number(paymobConfig.integrationId));
        }
    } else {
        // 'ALL' or default: allow all configured integrations (both cards and mobile wallets)
        if (Array.isArray(paymobConfig.integrationIds) && paymobConfig.integrationIds.length > 0) {
            paymentMethods.push(...paymobConfig.integrationIds);
        } else if (paymobConfig.integrationId && !isNaN(paymobConfig.integrationId)) {
            paymentMethods.push(Number(paymobConfig.integrationId));
        }
    }

    const safeAmount = Number(amountPiastres);

    // Paymob Intention API rejects empty items list `[]`.
    // It requires a non-empty array with name, amount (or amount_cents), description, and quantity.
    const safeItems = (Array.isArray(items) && items.length > 0)
        ? items
        : [
            {
                name: 'شحن رصيد / خدمة مشاوير',
                amount: safeAmount,
                amount_cents: safeAmount,
                description: specialReference || 'خدمة مشاوير',
                quantity: 1,
            },
        ];

    // Paymob Intention API expects expiration as relative lifetime in seconds (max 3110400 seconds = 36 days)
    const expirationSeconds = PAYMENT_EXPIRY_MINUTES * 60;

    return {
        amount:           safeAmount,
        currency:         'EGP',
        payment_methods:  paymentMethods,
        items:            safeItems,
        billing_data:     billingData,
        special_reference: specialReference,
        notification_url:  notificationUrl,
        redirection_url:   redirectionUrl,
        expiration:        expirationSeconds,
        extras:            extras,
    };
}

/**
 * Extract the safe fields we store from a Paymob intention response.
 *
 * @param {object} intentionResponse - Raw Paymob intention response
 * @returns {object} Mapped fields
 */
function mapIntentionResponse(intentionResponse) {
    return {
        providerIntentionId: String(intentionResponse.id),
        providerOrderId:     intentionResponse.payment_keys?.[0]?.order
                             || intentionResponse.order?.id
                             || null,
        clientSecret:        intentionResponse.client_secret,
    };
}

/**
 * Build a sanitized (safe) payload summary for the PaymentEvent audit log.
 * NEVER includes CVV, PANs, or sensitive card data.
 *
 * @param {object} transaction - Raw Paymob transaction from webhook
 * @returns {object} Safe audit payload
 */
function buildSafeCallbackSummary(transaction) {
    return {
        id:                    transaction.id,
        order_id:              transaction.order?.id,
        amount_cents:          transaction.amount_cents,
        currency:              transaction.currency,
        success:               transaction.success,
        pending:               transaction.pending,
        is_voided:             transaction.is_voided,
        is_refunded:           transaction.is_refunded,
        error_occured:         transaction.error_occured,
        integration_id:        transaction.integration_id,
        // Masked card info — safe to store for support/debugging
        masked_pan:            transaction.source_data?.pan,
        source_type:           transaction.source_data?.type,
        source_sub_type:       transaction.source_data?.sub_type,
        created_at:            transaction.created_at,
    };
}

/**
 * Build BillingData for the Paymob intention from a User document.
 * Paymob requires at minimum first_name, last_name, phone_number, email.
 * Fields cannot be empty strings — use 'NA' as Paymob's accepted placeholder.
 *
 * @param {object} user - Mongoose User document (lean)
 * @returns {object} Paymob billing_data shape
 */
function buildBillingData(user) {
    const safe = (v) => (v && String(v).trim()) || 'NA';
    return {
        apartment:     'NA',
        email:         safe(user.email),
        floor:         'NA',
        first_name:    safe(user.firstName),
        street:        'NA',
        building:      'NA',
        phone_number:  safe(user.phone),
        shipping_method: 'NA',
        postal_code:   'NA',
        city:          safe(user.governorate) || 'NA',
        country:       'EG',
        last_name:     safe(user.lastName),
        state:         safe(user.governorate) || 'NA',
    };
}

module.exports = {
    buildIntentionPayload,
    mapIntentionResponse,
    buildSafeCallbackSummary,
    buildBillingData,
};
