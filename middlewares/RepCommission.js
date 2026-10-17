const mongoose = require('mongoose');
const joi = require('joi');

// ─── RepCommissionConfig Schema (Singleton) ────────────────────────────────────
// A single document that holds the commission percentages the admin sets
// for normal delivery reps and business reps.
// repEarnings = totalDeliveryPrice * commissionPct / 100

const RepCommissionConfigSchema = new mongoose.Schema(
    {
        // نسبة مندوب توصيل وشراء الطلبات (0-100)
        deliveryRepCommissionPct: {
            type: Number,
            required: true,
            min: 0,
            max: 100,
            default: 100,
        },
        // نسبة مندوب توصيل الأفراد (0-100)
        passengerRepCommissionPct: {
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
        // نسب عمولة مخصصة لكل نوع مركبة في توصيل الطلبات
        deliveryVehicleCommissions: [
            {
                vehicleTypeId: { type: String, required: true },
                name_ar: { type: String, default: '' },
                commissionPct: { type: Number, required: true, min: 0, max: 100 },
            },
        ],
        // نسب عمولة مخصصة لكل نوع مركبة في توصيل الأفراد
        passengerVehicleCommissions: [
            {
                vehicleTypeId: { type: String, required: true },
                name_ar: { type: String, default: '' },
                commissionPct: { type: Number, required: true, min: 0, max: 100 },
            },
        ],
    },
    { timestamps: true }
);

const RepCommissionConfig = mongoose.model('RepCommissionConfig', RepCommissionConfigSchema);

// ─── Singleton Getter ──────────────────────────────────────────────────────────

async function getOrCreateRepCommission() {
    if (mongoose.connection.readyState !== 1) {
        return {
            deliveryRepCommissionPct: 100,
            passengerRepCommissionPct: 100,
            businessRepCommissionPct: 100,
            deliveryVehicleCommissions: [],
            passengerVehicleCommissions: [],
        };
    }
    let config = await RepCommissionConfig.findOne();
    if (!config) {
        config = await RepCommissionConfig.create({});
    }
    if (config.passengerRepCommissionPct === undefined) {
        config.passengerRepCommissionPct = 100;
    }
    if (!config.deliveryVehicleCommissions) {
        config.deliveryVehicleCommissions = [];
    }
    if (!config.passengerVehicleCommissions) {
        config.passengerVehicleCommissions = [];
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
    const vehicleCommItem = joi.object({
        vehicleTypeId: joi.string().required().messages({
            'any.required': 'vehicleTypeId is required for vehicle commission',
        }),
        name_ar: joi.string().allow('', null).optional(),
        commissionPct: joi.number().min(0).max(100).required().messages({
            'number.min': 'commissionPct cannot be negative',
            'number.max': 'commissionPct cannot exceed 100',
            'any.required': 'commissionPct is required',
        }),
    });

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
            passengerRepCommissionPct: joi
                .number()
                .min(0)
                .max(100)
                .messages({
                    'number.min': 'passengerRepCommissionPct cannot be negative',
                    'number.max': 'passengerRepCommissionPct cannot exceed 100',
                }),
            businessRepCommissionPct: joi
                .number()
                .min(0)
                .max(100)
                .messages({
                    'number.min': 'businessRepCommissionPct cannot be negative',
                    'number.max': 'businessRepCommissionPct cannot exceed 100',
                }),
            deliveryVehicleCommissions: joi.array().items(vehicleCommItem).optional(),
            passengerVehicleCommissions: joi.array().items(vehicleCommItem).optional(),
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

/**
 * استخراج ومطابقة نسبة العمولة من قائمة المركبات المتخصصة
 * @private
 */
function _findVehicleCommissionPct(list, vTypeId, vName) {
    if (!Array.isArray(list) || list.length === 0) return null;

    // 1. بحث بالـ ID
    if (vTypeId) {
        const idStr = String(vTypeId).trim();
        const found = list.find((item) => item && item.vehicleTypeId && String(item.vehicleTypeId).trim() === idStr);
        if (found && typeof found.commissionPct === 'number' && !isNaN(found.commissionPct)) {
            return Number(found.commissionPct);
        }
    }

    // 2. بحث باسم المركبة
    if (vName) {
        const normName = String(vName).trim().toLowerCase();
        const found = list.find((item) => {
            if (!item) return false;
            const itemAr = (item.name_ar || '').trim().toLowerCase();
            const itemEn = (item.name_en || '').trim().toLowerCase();
            return (itemAr && (normName.includes(itemAr) || itemAr.includes(normName))) ||
                   (itemEn && (normName.includes(itemEn) || itemEn.includes(normName)));
        });
        if (found && typeof found.commissionPct === 'number' && !isNaN(found.commissionPct)) {
            return Number(found.commissionPct);
        }
    }

    return null;
}

/**
 * استخراج نسبة عمولة المندوب (0-100) بشكل غير تزامني شامل:
 * - يدعم تخصص الطلب: توصيل طلبات vs توصيل أفراد
 * - يدعم نوع المركبة (من الطلب أو من بيانات المندوب أو بجلبها من User)
 * - يبحث في الإعدادات المخصصة للمركبات ثم يرجع للنسبة العامة للتخصص
 *
 * @param {Object} params
 * @param {Object} params.order - كائن الطلب
 * @param {Object} [params.repUser] - كائن بيانات المندوب
 * @param {string} [params.repId] - معرف المندوب
 * @param {Object} [params.commissionCfg] - إعدادات العمولة المخبأة
 * @returns {Promise<number>} نسبة العمولة التي يستحقها المندوب من سعر التوصيل (0-100)
 */
async function resolveOrderRepCommissionPct({ order, repUser = null, repId = null, commissionCfg = null }) {
    if (!commissionCfg) {
        commissionCfg = await getCachedRepCommission().catch(() => null);
    }

    const cat = (order?.orderCategory || order?.orderType || '').toString().toLowerCase().trim();
    const isPassenger = cat === 'passenger';
    const defaultPct = isPassenger
        ? (commissionCfg?.passengerRepCommissionPct ?? 100)
        : (commissionCfg?.deliveryRepCommissionPct ?? 100);

    let vTypeId = order?.vehicleTypeId ? String(order.vehicleTypeId).trim() : null;
    let vName = (order?.vehicleTypeName || order?.vehicleName || '').toString().trim();

    // إذا لم تكن المركبة مسجلة على الطلب، نستخدم مركبة المندوب
    if (!vTypeId && !vName) {
        if (!repUser) {
            const targetRepId = repId || order?.representativeId;
            if (targetRepId && mongoose.isValidObjectId(targetRepId)) {
                try {
                    const { User } = require('./User');
                    repUser = await User.findById(targetRepId).select('vehicleTypeId vehicleTypeName').lean();
                } catch (_) {}
            }
        }

        if (repUser) {
            vTypeId = repUser.vehicleTypeId ? String(repUser.vehicleTypeId).trim() : null;
            vName = (repUser.vehicleTypeName || '').toString().trim();
        }
    }

    // 1. فحص قوائم نسب المركبات المخصصة في إعدادات العمولة
    const vehicleList = isPassenger
        ? (commissionCfg?.passengerVehicleCommissions || [])
        : (commissionCfg?.deliveryVehicleCommissions || []);

    const matchedPct = _findVehicleCommissionPct(vehicleList, vTypeId, vName);
    if (matchedPct !== null) {
        return Math.max(0, Math.min(100, matchedPct));
    }

    // 2. إذا لم توجد في القائمة، فحص وثيقة VehicleType نفسها إن كانت تحتوي على نسبة مخصصة
    if (vTypeId && mongoose.isValidObjectId(vTypeId)) {
        try {
            const { VehicleType } = require('./VehicleType');
            const vtDoc = await VehicleType.findById(vTypeId).select('deliveryCommissionPct passengerCommissionPct').lean();
            if (vtDoc) {
                const specificPct = isPassenger ? vtDoc.passengerCommissionPct : vtDoc.deliveryCommissionPct;
                if (typeof specificPct === 'number' && !isNaN(specificPct) && specificPct >= 0) {
                    return Math.max(0, Math.min(100, specificPct));
                }
            }
        } catch (_) {}
    }

    // 3. Fallback للنسبة العامة للتخصص
    return Math.max(0, Math.min(100, Number(defaultPct)));
}

/**
 * دالة تزامنية سريعة لحساب نسبة عمولة المندوب (مناسبة لعرض القوائم formatOrder)
 *
 * @param {Object} params
 * @param {Object} params.order
 * @param {Object} [params.repUser]
 * @param {Object} [params.commissionCfg]
 * @returns {number}
 */
function resolveOrderRepCommissionPctSync({ order, repUser = null, commissionCfg = null }) {
    const cat = (order?.orderCategory || order?.orderType || '').toString().toLowerCase().trim();
    const isPassenger = cat === 'passenger';
    const defaultPct = isPassenger
        ? (commissionCfg?.passengerRepCommissionPct ?? 100)
        : (commissionCfg?.deliveryRepCommissionPct ?? 100);

    let vTypeId = order?.vehicleTypeId ? String(order.vehicleTypeId).trim() : null;
    let vName = (order?.vehicleTypeName || order?.vehicleName || '').toString().trim();

    if (!vTypeId && !vName && repUser) {
        vTypeId = repUser.vehicleTypeId ? String(repUser.vehicleTypeId).trim() : null;
        vName = (repUser.vehicleTypeName || '').toString().trim();
    }

    const vehicleList = isPassenger
        ? (commissionCfg?.passengerVehicleCommissions || [])
        : (commissionCfg?.deliveryVehicleCommissions || []);

    const matchedPct = _findVehicleCommissionPct(vehicleList, vTypeId, vName);
    if (matchedPct !== null) {
        return Math.max(0, Math.min(100, matchedPct));
    }

    return Math.max(0, Math.min(100, Number(defaultPct)));
}

module.exports = {
    RepCommissionConfig,
    getOrCreateRepCommission,
    getCachedRepCommission,
    invalidateRepCommissionCache,
    validateUpdateRepCommission,
    calcRepEarnings,
    resolveOrderRepCommissionPct,
    resolveOrderRepCommissionPctSync,
};
