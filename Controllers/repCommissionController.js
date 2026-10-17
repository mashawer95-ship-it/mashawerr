const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const {
    getOrCreateRepCommission,
    validateUpdateRepCommission,
    invalidateRepCommissionCache,
} = require('../middlewares/RepCommission');
const { VehicleType } = require('../middlewares/VehicleType');

/**
 * دالة مساعدة لتجميع وتجهيز بيانات المركبات ونسب عمولتها
 */
async function buildEnrichedVehicleCommissions(config) {
    let vehicleTypes = [];
    try {
        vehicleTypes = await VehicleType.find({ isActive: true }).sort({ createdAt: 1 }).lean();
    } catch (_) {
        vehicleTypes = [];
    }

    const deliveryConfigList = Array.isArray(config.deliveryVehicleCommissions) ? config.deliveryVehicleCommissions : [];
    const passengerConfigList = Array.isArray(config.passengerVehicleCommissions) ? config.passengerVehicleCommissions : [];

    // 1. مركبات توصيل الطلبات (delivery or both)
    const deliveryVehicles = vehicleTypes
        .filter((v) => !v.category || v.category === 'delivery' || v.category === 'both')
        .map((vt) => {
            const vtId = vt._id ? vt._id.toString() : '';
            const customEntry = deliveryConfigList.find((c) => c && String(c.vehicleTypeId).trim() === vtId);
            let pct = null;
            if (customEntry && typeof customEntry.commissionPct === 'number' && !isNaN(customEntry.commissionPct)) {
                pct = customEntry.commissionPct;
            } else if (typeof vt.deliveryCommissionPct === 'number' && !isNaN(vt.deliveryCommissionPct)) {
                pct = vt.deliveryCommissionPct;
            }

            return {
                vehicleTypeId: vtId,
                name_ar: vt.name_ar || '',
                name_en: vt.name_en || '',
                icon_key: vt.icon_key || 'motorcycle',
                image: vt.image || null,
                category: vt.category || 'delivery',
                is_ladies_only: Boolean(vt.is_ladies_only),
                commissionPct: pct !== null ? pct : (config.deliveryRepCommissionPct ?? 100),
                hasCustomPct: pct !== null,
            };
        });

    // 2. مركبات توصيل الأفراد (passenger or both)
    const passengerVehicles = vehicleTypes
        .filter((v) => v.category === 'passenger' || v.category === 'both')
        .map((vt) => {
            const vtId = vt._id ? vt._id.toString() : '';
            const customEntry = passengerConfigList.find((c) => c && String(c.vehicleTypeId).trim() === vtId);
            let pct = null;
            if (customEntry && typeof customEntry.commissionPct === 'number' && !isNaN(customEntry.commissionPct)) {
                pct = customEntry.commissionPct;
            } else if (typeof vt.passengerCommissionPct === 'number' && !isNaN(vt.passengerCommissionPct)) {
                pct = vt.passengerCommissionPct;
            }

            return {
                vehicleTypeId: vtId,
                name_ar: vt.name_ar || '',
                name_en: vt.name_en || '',
                icon_key: vt.icon_key || 'sedan',
                image: vt.image || null,
                category: vt.category || 'passenger',
                is_ladies_only: Boolean(vt.is_ladies_only),
                commissionPct: pct !== null ? pct : (config.passengerRepCommissionPct ?? 100),
                hasCustomPct: pct !== null,
            };
        });

    return { deliveryVehicles, passengerVehicles };
}

/**
 * @desc  Get the current representative commission configuration
 * @route GET /api/rep-commission
 * @access Public (Admin + Representatives can read)
 */
const getRepCommission = asyncHandler(async (req, res) => {
    const config = await getOrCreateRepCommission();
    const { deliveryVehicles, passengerVehicles } = await buildEnrichedVehicleCommissions(config);

    return res.status(200).json({
        deliveryRepCommissionPct: config.deliveryRepCommissionPct,
        passengerRepCommissionPct: config.passengerRepCommissionPct ?? 100,
        businessRepCommissionPct: config.businessRepCommissionPct,
        deliveryVehicleCommissions: deliveryVehicles,
        passengerVehicleCommissions: passengerVehicles,
        updatedAt: config.updatedAt,
    });
});

/**
 * @desc  Update representative commission percentages
 * @route PUT /api/rep-commission
 * @access Admin only
 */
const updateRepCommission = asyncHandler(async (req, res) => {
    const { error, value } = validateUpdateRepCommission(req.body);
    if (error) {
        return res.status(400).json({
            message: error.details.map((d) => d.message).join('; '),
        });
    }

    const config = await getOrCreateRepCommission();

    if (value.deliveryRepCommissionPct !== undefined) {
        config.deliveryRepCommissionPct = value.deliveryRepCommissionPct;
    }
    if (value.passengerRepCommissionPct !== undefined) {
        config.passengerRepCommissionPct = value.passengerRepCommissionPct;
    }
    if (value.businessRepCommissionPct !== undefined) {
        config.businessRepCommissionPct = value.businessRepCommissionPct;
    }

    if (Array.isArray(value.deliveryVehicleCommissions)) {
        config.deliveryVehicleCommissions = value.deliveryVehicleCommissions.map((item) => ({
            vehicleTypeId: String(item.vehicleTypeId).trim(),
            name_ar: (item.name_ar || '').trim(),
            commissionPct: Number(item.commissionPct),
        }));

        // مزامنة مع جدول أنواع المركبات
        for (const item of value.deliveryVehicleCommissions) {
            if (mongoose.isValidObjectId(item.vehicleTypeId)) {
                await VehicleType.findByIdAndUpdate(item.vehicleTypeId, {
                    deliveryCommissionPct: Number(item.commissionPct),
                }).catch(() => {});
            }
        }
    }

    if (Array.isArray(value.passengerVehicleCommissions)) {
        config.passengerVehicleCommissions = value.passengerVehicleCommissions.map((item) => ({
            vehicleTypeId: String(item.vehicleTypeId).trim(),
            name_ar: (item.name_ar || '').trim(),
            commissionPct: Number(item.commissionPct),
        }));

        // مزامنة مع جدول أنواع المركبات
        for (const item of value.passengerVehicleCommissions) {
            if (mongoose.isValidObjectId(item.vehicleTypeId)) {
                await VehicleType.findByIdAndUpdate(item.vehicleTypeId, {
                    passengerCommissionPct: Number(item.commissionPct),
                }).catch(() => {});
            }
        }
    }

    await config.save();

    // Invalidate in-process cache so next request picks up new values
    invalidateRepCommissionCache();

    const { deliveryVehicles, passengerVehicles } = await buildEnrichedVehicleCommissions(config);

    return res.status(200).json({
        message: 'تم تحديث نسب عمولة المناديب بنجاح',
        deliveryRepCommissionPct: config.deliveryRepCommissionPct,
        passengerRepCommissionPct: config.passengerRepCommissionPct,
        businessRepCommissionPct: config.businessRepCommissionPct,
        deliveryVehicleCommissions: deliveryVehicles,
        passengerVehicleCommissions: passengerVehicles,
        updatedAt: config.updatedAt,
    });
});

module.exports = {
    getRepCommission,
    updateRepCommission,
};
