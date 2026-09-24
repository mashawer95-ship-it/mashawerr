const mongoose = require('mongoose');
const joi = require('joi');

// ─── RepCommissionConfig Schema (Singleton) ────────────────────────────────────
// A single document that holds the commission percentages the admin sets
// for normal delivery reps and business reps.
// repEarnings = totalDeliveryPrice * commissionPct / 100

const RepCommissionConfigSchema = new mongoose.Schema(
    {
        // نسبة مندوب التوصيل العادي (0-100)
        deliveryRepCommissionPct: {
            type: Number,
            required: true,
            min: 0,
            max: 100,
            default: 100,
        },
        // نسبة مندوب البيزنيس / المتجر (0-100)
        businessRepCommissionPct: {
            type: Number,
            required: true,
            min: 0,
            max: 100,
            default: 100,
        },
    },
    { timestamps: true }
);

const RepCommissionConfig = mongoose.model('RepCommissionConfig', RepCommissionConfigSchema);

// ─── Singleton Getter ──────────────────────────────────────────────────────────

async function getOrCreateRepCommission() {
    if (mongoose.connection.readyState !== 1) {
        return { deliveryRepCommissionPct: 100, businessRepCommissionPct: 100 };
    }
    let config = await RepCommissionConfig.findOne();
    if (!config) {
        config = await RepCommissionConfig.create({});
    }
    return config;
}

// ─── In-process cache (TTL: 60 seconds) ───────────────────────────────────────
let _cachedConfig = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60 * 1000;

async function getCachedRepCommission() {
    const now = Date.now();
    if (_cachedConfig && (now - _cachedAt) < CACHE_TTL_MS) {
        return _cachedConfig;
    }
    _cachedConfig = await getOrCreateRepCommission();
    _cachedAt = now;
    return _cachedConfig;
}

/** Invalidate in-process cache (call after admin updates) */
function invalidateRepCommissionCache() {
    _cachedConfig = null;
    _cachedAt = 0;
}

// ─── Joi Validator ─────────────────────────────────────────────────────────────

function validateUpdateRepCommission(obj) {
    const schema = joi
        .object({
            deliveryRepCommissionPct: joi
                .number()
                .min(0)
                .max(100)
                .messages({
                    'number.min': 'deliveryRepCommissionPct cannot be negative',
                    'number.max': 'deliveryRepCommissionPct cannot exceed 100',
                }),
            businessRepCommissionPct: joi
                .number()
                .min(0)
                .max(100)
                .messages({
                    'number.min': 'businessRepCommissionPct cannot be negative',
                    'number.max': 'businessRepCommissionPct cannot exceed 100',
                }),
        })
        .min(1)
        .messages({ 'object.min': 'Send at least one field to update' });
    return schema.validate(obj, { abortEarly: false });
}

/**
 * حساب أرباح المندوب من سعر التوصيل
 * @param {number} deliveryPriceKD - سعر التوصيل بالدينار الكويتي
 * @param {number} commissionPct - نسبة العمولة (0-100)
 * @returns {number} أرباح المندوب بالدينار (3 أرقام عشرية)
 */
function calcRepEarnings(deliveryPriceKD, commissionPct) {
    if (!deliveryPriceKD || deliveryPriceKD <= 0) return 0;
    const pct = typeof commissionPct === 'number' ? commissionPct : 100;
    return Number(((deliveryPriceKD * pct) / 100).toFixed(3));
}

module.exports = {
    RepCommissionConfig,
    getOrCreateRepCommission,
    getCachedRepCommission,
    invalidateRepCommissionCache,
    validateUpdateRepCommission,
    calcRepEarnings,
};
