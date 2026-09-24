const asyncHandler = require('express-async-handler');
const {
    getOrCreatePricing,
    validateCalculatePrice,
    validateUpdatePricing,
    kdToFils,
    filsToKd,
    filsToArabicName,
} = require('../middlewares/Pricing');

function pricingToFilsResponse(pricing) {
    const baseFare = kdToFils(pricing.baseFare);
    const pricePerMeter = kdToFils(pricing.pricePerMeter);
    const minFare = kdToFils(pricing.minFare);
    const maxNegativeBalanceFils = pricing.maxNegativeBalanceFils !== undefined ? pricing.maxNegativeBalanceFils : 5000;
    return {
        baseFare,
        baseFare_name_ar: filsToArabicName(baseFare),
        pricePerMeter,
        pricePerMeter_name_ar: `سعر المتر: ${filsToArabicName(pricePerMeter)}`,
        minFare,
        minFare_name_ar: filsToArabicName(minFare),
        surgeMultiplier: pricing.surgeMultiplier,
        arrivalTimerMinutes: pricing.arrivalTimerMinutes || 10,
        clientCancellationTimerMinutes: pricing.clientCancellationTimerMinutes ?? 10,
        cancellationFeeForClient: pricing.cancellationFeeForClient || 0,
        cancellationRewardForDriver: pricing.cancellationRewardForDriver || 0,
        delayFeeForClient: pricing.delayFeeForClient || 0,
        delayRewardForDriver: pricing.delayRewardForDriver || 0,
        maxNegativeBalanceFils,
        maxNegativeBalance_name_ar: filsToArabicName(maxNegativeBalanceFils),
        updatedAt: pricing.updatedAt,
    };
}

/**
 * @description Calculate ride price based on distance
 * @route POST /api/pricing/calculate-price
 * @access Private (JWT)
 */
const calculatePrice = asyncHandler(async (req, res) => {
    const { error } = validateCalculatePrice(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { distance_meters } = req.body;
    const pricing = await getOrCreatePricing();

    // Strictly per-meter (+ baseFare); minFare is not applied here so short trips show actual fils (e.g. 20 fils).
    let totalPrice = pricing.baseFare + (distance_meters * pricing.pricePerMeter);

    totalPrice = totalPrice * pricing.surgeMultiplier;

    const priceFils = kdToFils(totalPrice);

    return res.status(200).json({
        distance_meters,
        price: priceFils,
        name_ar: filsToArabicName(priceFils),
    });
});

/**
 * @description Update pricing configuration (partial). Values in fils; DB stores KD.
 * @route PUT /api/pricing — body/response amounts in fils only (not KD)
 * @access Private (JWT)
 */
const updatePricing = asyncHandler(async (req, res) => {
    const { error } = validateUpdatePricing(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const {
        baseFare,
        pricePerMeter,
        minFare,
        surgeMultiplier,
        arrivalTimerMinutes,
        clientCancellationTimerMinutes,
        cancellationFeeForClient,
        cancellationRewardForDriver,
        delayFeeForClient,
        delayRewardForDriver,
        maxNegativeBalanceFils,
    } = req.body;

    let pricing = await getOrCreatePricing();

    if (baseFare !== undefined) pricing.baseFare = filsToKd(baseFare);
    if (pricePerMeter !== undefined) pricing.pricePerMeter = filsToKd(pricePerMeter);
    if (minFare !== undefined) pricing.minFare = filsToKd(minFare);
    if (surgeMultiplier !== undefined) pricing.surgeMultiplier = surgeMultiplier;
    if (arrivalTimerMinutes !== undefined) pricing.arrivalTimerMinutes = arrivalTimerMinutes;
    if (clientCancellationTimerMinutes !== undefined) pricing.clientCancellationTimerMinutes = clientCancellationTimerMinutes;
    if (cancellationFeeForClient !== undefined) pricing.cancellationFeeForClient = cancellationFeeForClient;
    if (cancellationRewardForDriver !== undefined) pricing.cancellationRewardForDriver = cancellationRewardForDriver;
    if (delayFeeForClient !== undefined) pricing.delayFeeForClient = delayFeeForClient;
    if (delayRewardForDriver !== undefined) pricing.delayRewardForDriver = delayRewardForDriver;
    if (maxNegativeBalanceFils !== undefined) {
        let val = Math.abs(Number(maxNegativeBalanceFils));
        if (val > 0 && val <= 50) {
            val = Math.round(val * 1000); // 5 KD -> 5000 fils
        }
        pricing.maxNegativeBalanceFils = val;
    }

    pricing.updatedAt = new Date();

    await pricing.save();

    return res.status(200).json({
        message: 'Pricing updated successfully',
        pricing: pricingToFilsResponse(pricing),
    });
});

/**
 * @description Get current pricing configuration
 * @route GET /api/pricing
 * @access Private (JWT)
 */
const getPricing = asyncHandler(async (req, res) => {
    const pricing = await getOrCreatePricing();

    return res.status(200).json(pricingToFilsResponse(pricing));
});

module.exports = { calculatePrice, updatePricing, getPricing };
