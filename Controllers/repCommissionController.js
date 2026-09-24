const asyncHandler = require('express-async-handler');
const {
    getOrCreateRepCommission,
    validateUpdateRepCommission,
    invalidateRepCommissionCache,
} = require('../middlewares/RepCommission');

/**
 * @desc  Get the current representative commission configuration
 * @route GET /api/rep-commission
 * @access Public (Admin + Representatives can read)
 */
const getRepCommission = asyncHandler(async (req, res) => {
    const config = await getOrCreateRepCommission();
    return res.status(200).json({
        deliveryRepCommissionPct: config.deliveryRepCommissionPct,
        businessRepCommissionPct: config.businessRepCommissionPct,
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
    if (value.businessRepCommissionPct !== undefined) {
        config.businessRepCommissionPct = value.businessRepCommissionPct;
    }

    await config.save();

    // Invalidate in-process cache so next request picks up new values
    invalidateRepCommissionCache();

    return res.status(200).json({
        message: 'تم تحديث نسب عمولة المناديب بنجاح',
        deliveryRepCommissionPct: config.deliveryRepCommissionPct,
        businessRepCommissionPct: config.businessRepCommissionPct,
        updatedAt: config.updatedAt,
    });
});

module.exports = {
    getRepCommission,
    updateRepCommission,
};
