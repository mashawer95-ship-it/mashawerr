const mongoose = require('mongoose');
const joi = require('joi');

/** 1000 fils = 1 Kuwaiti Dinar (KD). API uses fils; DB stores KD. */
const FILS_PER_KD = 1000;

/** Convert KD → fils; preserves fractional fils (e.g. 0.0005 KD → 0.5 fils). */
function kdToFils(kd) {
    const fils = Number(kd) * FILS_PER_KD;
    return Number(fils.toFixed(6));
}

function filsToKd(fils) {
    return Number(fils) / FILS_PER_KD;
}

function trimKdDisplay(kd) {
    const s = Number(kd).toFixed(6);
    return s.replace(/\.?0+$/, '') || '0';
}

/**
 * Arabic display name for an amount in fils (supports fractional fils, e.g. 0.5, 0.25).
 */
function filsToArabicName(fils) {
    const n = Number(Number(fils).toFixed(6));
    if (n === 0) return '0 د.ك';
    const kd = n / FILS_PER_KD;
    if (Number.isInteger(n) && n === 500) return 'نص دينار (0.500)';
    if (Number.isInteger(n) && n === 1000) return '1 د.ك';
    if (n < 1000) return `${n} فلس (${trimKdDisplay(kd)} د.ك)`;
    if (Number.isInteger(kd) && kd === Math.trunc(kd)) return `${Math.trunc(kd)} د.ك`;
    return `${trimKdDisplay(kd)} د.ك`;
}

const DEFAULT_PRICING = {
    baseFare: 0,
    pricePerMeter: 0.001,   // 1 fil per meter (stored in KD: 0.001 KD/m)
    minFare: 0,             // 0 = no minimum floor (small trips can be e.g. 50 fils)
    surgeMultiplier: 1,
    // ─── التايمر ورسوم التأخير/الإلغاء والحد الأقصى للمديونية ───────────────
    arrivalTimerMinutes: 10,            // مدة تايمر تأخير الاستلام بعد وصول المندوب (بالدقائق)
    clientCancellationTimerMinutes: 10, // مدة مهلة إلغاء الطلب للعميل بعد قبول المندوب (بالدقائق)
    cancellationFeeForClient: 0,        // رسوم الإلغاء على العميل (بالفلس)
    cancellationRewardForDriver: 0,     // مكافأة المندوب عند إلغاء العميل (بالفلس)
    delayFeeForClient: 0,               // رسوم التأخير على العميل (بالفلس)
    delayRewardForDriver: 0,            // مكافأة المندوب عند تأخر العميل (بالفلس)
    maxNegativeBalanceFils: 5000,       // الحد الأقصى للرصيد السالب المسموح به في المحفظة (بالفلس) - 5000 فلس = 5 د.ك
};

const PricingSchema = new mongoose.Schema(
    {
        baseFare: {
            type: Number,
            required: true,
            min: 0,
            default: DEFAULT_PRICING.baseFare,
        },
        pricePerMeter: {
            type: Number,
            required: true,
            min: 0,
            default: DEFAULT_PRICING.pricePerMeter,
        },
        minFare: {
            type: Number,
            required: true,
            min: 0,
            default: DEFAULT_PRICING.minFare,
        },
        surgeMultiplier: {
            type: Number,
            required: true,
            min: 0,
            default: DEFAULT_PRICING.surgeMultiplier,
        },
        // ─── مدة التايمر ورسوم/مكافآت التأخير والإلغاء ───────────────────────
        arrivalTimerMinutes: {
            type: Number,
            min: 1,
            default: DEFAULT_PRICING.arrivalTimerMinutes,
        },
        clientCancellationTimerMinutes: {
            type: Number,
            min: 1,
            default: DEFAULT_PRICING.clientCancellationTimerMinutes,
        },
        cancellationFeeForClient: {
            type: Number,
            min: 0,
            default: DEFAULT_PRICING.cancellationFeeForClient,
        },
        cancellationRewardForDriver: {
            type: Number,
            min: 0,
            default: DEFAULT_PRICING.cancellationRewardForDriver,
        },
        delayFeeForClient: {
            type: Number,
            min: 0,
            default: DEFAULT_PRICING.delayFeeForClient,
        },
        delayRewardForDriver: {
            type: Number,
            min: 0,
            default: DEFAULT_PRICING.delayRewardForDriver,
        },
        // ─── الحد الأقصى للرصيد السالب للمحفظة ──────────────────────────────
        maxNegativeBalanceFils: {
            type: Number,
            min: 0,
            default: DEFAULT_PRICING.maxNegativeBalanceFils,
        },
        updatedAt: {
            type: Date,
            default: Date.now,
        },
    },
    { versionKey: false }
);

const Pricing = mongoose.model('Pricing', PricingSchema);

/**
 * Returns the singleton pricing document. Creates it with defaults if missing.
 */
async function getOrCreatePricing() {
    let pricing = await Pricing.findOne();
    if (!pricing) {
        pricing = await Pricing.create(DEFAULT_PRICING);
    }
    return pricing;
}

function validateCalculatePrice(object) {
    const schema = joi.object({
        distance_meters: joi.number().min(0).required().messages({
            'number.base': 'distance_meters must be a number',
            'number.min': 'distance_meters cannot be negative',
            'any.required': 'distance_meters is required',
        }),
    });
    return schema.validate(object);
}

const filsField = (name) =>
    joi.number().min(0).max(1e12).messages({
        'number.base': `${name} must be a number (fils, decimals allowed e.g. 0.5, 0.25)`,
        'number.min': `${name} cannot be negative`,
        'number.max': `${name} is too large`,
    });

function validateUpdatePricing(object) {
    const schema = joi.object({
        baseFare: filsField('baseFare'),
        pricePerMeter: filsField('pricePerMeter'),
        minFare: filsField('minFare'),
        surgeMultiplier: joi.number().min(0).messages({
            'number.base': 'surgeMultiplier must be a number',
            'number.min': 'surgeMultiplier cannot be negative',
        }),
        // ─── إعدادات التأخير والإلغاء والمديونية ───────────────────────────
        arrivalTimerMinutes: joi.number().integer().min(1).max(120).messages({
            'number.base': 'arrivalTimerMinutes must be a number',
            'number.min': 'arrivalTimerMinutes must be at least 1 minute',
            'number.max': 'arrivalTimerMinutes cannot exceed 120 minutes',
        }),
        clientCancellationTimerMinutes: joi.number().integer().min(1).max(120).messages({
            'number.base': 'clientCancellationTimerMinutes must be a number',
            'number.min': 'clientCancellationTimerMinutes must be at least 1 minute',
            'number.max': 'clientCancellationTimerMinutes cannot exceed 120 minutes',
        }),
        cancellationFeeForClient: filsField('cancellationFeeForClient'),
        cancellationRewardForDriver: filsField('cancellationRewardForDriver'),
        delayFeeForClient: filsField('delayFeeForClient'),
        delayRewardForDriver: filsField('delayRewardForDriver'),
        maxNegativeBalanceFils: joi.number().max(1e12).allow(null).messages({
            'number.base': 'maxNegativeBalanceFils must be a number (fils, e.g. 5000 or -5000)',
            'number.max': 'maxNegativeBalanceFils is too large',
        }),
    }).min(1).unknown(false).messages({
        'object.min': 'Send at least one field to update',
        'object.unknown': 'Unknown field — only allowed pricing fields are accepted',
    });
    return schema.validate(object);
}

module.exports = {
    Pricing,
    getOrCreatePricing,
    validateCalculatePrice,
    validateUpdatePricing,
    DEFAULT_PRICING,
    FILS_PER_KD,
    kdToFils,
    filsToKd,
    filsToArabicName,
};
