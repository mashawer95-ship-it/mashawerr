const mongoose = require('mongoose');
const joi = require('joi');

/** 1000 fils = 1 Kuwaiti Dinar (KD). API uses fils; DB stores KD. */
const FILS_PER_KD = 1000;

function kdToFils(kd) {
    const fils = Number(kd) * FILS_PER_KD;
    return Math.round(fils);
}

function filsToKd(fils) {
    return Number(fils) / FILS_PER_KD;
}

function trimKdDisplay(kd) {
    const s = Number(kd).toFixed(6);
    return s.replace(/\.?0+$/, '') || '0';
}

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

const DEFAULT_STORE_PRICING = {
    baseFare: 0,
    pricePerMeter: 0.001,   // 1 fil per meter (stored in KD: 0.001 KD/m)
    minFare: 0,             // 0 = no minimum floor
    surgeMultiplier: 1,
};

const StorePricingSchema = new mongoose.Schema(
    {
        baseFare: {
            type: Number,
            required: true,
            min: 0,
            default: DEFAULT_STORE_PRICING.baseFare,
        },
        pricePerMeter: {
            type: Number,
            required: true,
            min: 0,
            default: DEFAULT_STORE_PRICING.pricePerMeter,
        },
        minFare: {
            type: Number,
            required: true,
            min: 0,
            default: DEFAULT_STORE_PRICING.minFare,
        },
        surgeMultiplier: {
            type: Number,
            required: true,
            min: 0,
            default: DEFAULT_STORE_PRICING.surgeMultiplier,
        },
        updatedAt: {
            type: Date,
            default: Date.now,
        },
    },
    { versionKey: false }
);

const StorePricing = mongoose.model('StorePricing', StorePricingSchema);

async function getOrCreateStorePricing() {
    let pricing = await StorePricing.findOne();
    if (!pricing) {
        pricing = await StorePricing.create(DEFAULT_STORE_PRICING);
    }
    return pricing;
}

// ── Haversine Formula ──
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const toRadians = (degrees) => (degrees * Math.PI) / 180;

    const phi1 = toRadians(lat1);
    const phi2 = toRadians(lat2);
    const deltaPhi = toRadians(lat2 - lat1);
    const deltaLambda = toRadians(lon2 - lon1);

    const a =
        Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) *
        Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return Math.round(R * c);
}

// deduplicate locations based on 100m threshold
function deduplicateLocations(locations) {
    const unique = [];
    const thresholdMeters = 100;

    for (const loc of locations) {
        if (!loc || loc.lat == null || loc.lng == null) continue;
        const isDuplicate = unique.some(u => 
            calculateHaversineDistance(loc.lat, loc.lng, u.lat, u.lng) <= thresholdMeters
        );
        if (!isDuplicate) unique.push(loc);
    }
    return unique;
}

const locationSchema = joi.object({
    lat: joi.number().min(-90).max(90).required(),
    lng: joi.number().min(-180).max(180).required(),
    address: joi.string().trim().max(500).allow('', null).optional(),
});

function validateCalculateStorePricing(object) {
    const schema = joi.object({
        distance_meters: joi.number().min(0).optional().messages({
            'number.base': 'distance_meters must be a number',
            'number.min': 'distance_meters cannot be negative',
        }),
        pickups: joi.array().items(locationSchema).min(1).optional(),
        deliveries: joi.array().items(locationSchema).min(1).optional(),
        overridePricePerMeterFils: joi.number().min(0).optional().allow(null),
        overrideFlatFeeFils: joi.number().min(0).optional().allow(null),
    }).or('distance_meters', 'pickups').messages({
        'object.missing': 'You must provide either distance_meters or pickups/deliveries',
    });
    return schema.validate(object);
}

const filsField = (name) =>
    joi.number().min(0).max(1e12).messages({
        'number.base': `${name} must be a number (fils, decimals allowed e.g. 0.5, 0.25)`,
        'number.min': `${name} cannot be negative`,
        'number.max': `${name} is too large`,
    });

function validateUpdateStorePricing(object) {
    const schema = joi.object({
        baseFare: filsField('baseFare'),
        pricePerMeter: filsField('pricePerMeter'),
        minFare: filsField('minFare'),
        surgeMultiplier: joi.number().min(0).messages({
            'number.base': 'surgeMultiplier must be a number',
            'number.min': 'surgeMultiplier cannot be negative',
        }),
    }).min(1).unknown(false).messages({
        'object.min': 'Send at least one field: baseFare, pricePerMeter, minFare, or surgeMultiplier',
        'object.unknown': 'Unknown field — only baseFare, pricePerMeter, minFare, surgeMultiplier are allowed',
    });
    return schema.validate(object);
}

module.exports = {
    StorePricing,
    getOrCreateStorePricing,
    validateCalculateStorePricing,
    validateUpdateStorePricing,
    calculateHaversineDistance,
    deduplicateLocations,
    DEFAULT_STORE_PRICING,
    FILS_PER_KD,
    kdToFils,
    filsToKd,
    filsToArabicName,
};
