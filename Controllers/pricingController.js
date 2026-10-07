const asyncHandler = require('express-async-handler');
const {
    getOrCreatePricing,
    validateCalculatePrice,
    validateUpdatePricing,
    kdToFils,
    filsToKd,
    filsToArabicName,
} = require('../middlewares/Pricing');

/**
 * دالة مساعدة ذكية لتوحيد وتصحيح المبالغ المالية بالفلس.
 * إذا أدخل الأدمن أو أرسل التطبيق المبلغ بوحدة الجنيه/الدينار (مثلاً 5 أو 10 أو 15 أو 50 ج.م)،
 * يتم ضربها في 1000 لتحويلها إلى فلس تلقائياً منعاً لخصم فلسات ضئيلة (0.01 ج.م).
 * إذا كان المبلغ بالفعل بالفلس (مثلاً 5000 أو 10000 أو 15000 فلس)، يُحفظ كما هو.
 */
function normalizeFeeToFils(val) {
    if (val === undefined || val === null) return undefined;
    const num = Math.abs(Number(val));
    if (isNaN(num)) return 0;
    if (num === 0) return 0;
    // أي قيمة أقل من 500 تُعتبر حتماً بالجنيه/الدينار (لأنه لا توجد رسوم أقل من نصف جنيه/دينار)
    if (num < 500) {
        return Math.round(num * 1000);
    }
    return Math.round(num);
}

function pricingToFilsResponse(pricing) {
    const baseFare = kdToFils(pricing.baseFare);
    const pricePerMeter = kdToFils(pricing.pricePerMeter);
    const minFare = kdToFils(pricing.minFare);
    
    const cancellationFeeForClient = normalizeFeeToFils(pricing.cancellationFeeForClient) || 0;
    const cancellationRewardForDriver = normalizeFeeToFils(pricing.cancellationRewardForDriver) || 0;
    const cancellationFeeForDriver = normalizeFeeToFils(pricing.cancellationFeeForDriver) || 0;
    const cancellationRewardForClient = normalizeFeeToFils(pricing.cancellationRewardForClient) || 0;
    const delayFeeForClient = normalizeFeeToFils(pricing.delayFeeForClient) || 0;
    const delayRewardForDriver = normalizeFeeToFils(pricing.delayRewardForDriver) || 0;
    const maxNegativeBalanceFils = normalizeFeeToFils(pricing.maxNegativeBalanceFils !== undefined ? pricing.maxNegativeBalanceFils : 5000) || 5000;

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
        cancellationFeeForClient,
        cancellationFeeForClient_kd: Number((cancellationFeeForClient / 1000).toFixed(3)),
        cancellationRewardForDriver,
        cancellationRewardForDriver_kd: Number((cancellationRewardForDriver / 1000).toFixed(3)),
        cancellationFeeForDriver,
        cancellationFeeForDriver_kd: Number((cancellationFeeForDriver / 1000).toFixed(3)),
        cancellationRewardForClient,
        cancellationRewardForClient_kd: Number((cancellationRewardForClient / 1000).toFixed(3)),
        delayFeeForClient,
        delayFeeForClient_kd: Number((delayFeeForClient / 1000).toFixed(3)),
        delayRewardForDriver,
        delayRewardForDriver_kd: Number((delayRewardForDriver / 1000).toFixed(3)),
        maxNegativeBalanceFils,
        maxNegativeBalance_name_ar: filsToArabicName(maxNegativeBalanceFils),
        maxNegativeBalance_kd: Number((maxNegativeBalanceFils / 1000).toFixed(3)),
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
        cancellationFeeForDriver,
        cancellationRewardForClient,
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
    if (cancellationFeeForClient !== undefined) pricing.cancellationFeeForClient = normalizeFeeToFils(cancellationFeeForClient);
    if (cancellationRewardForDriver !== undefined) pricing.cancellationRewardForDriver = normalizeFeeToFils(cancellationRewardForDriver);
    if (cancellationFeeForDriver !== undefined) pricing.cancellationFeeForDriver = normalizeFeeToFils(cancellationFeeForDriver);
    if (cancellationRewardForClient !== undefined) pricing.cancellationRewardForClient = normalizeFeeToFils(cancellationRewardForClient);
    if (delayFeeForClient !== undefined) pricing.delayFeeForClient = normalizeFeeToFils(delayFeeForClient);
    if (delayRewardForDriver !== undefined) pricing.delayRewardForDriver = normalizeFeeToFils(delayRewardForDriver);
    if (maxNegativeBalanceFils !== undefined) {
        pricing.maxNegativeBalanceFils = normalizeFeeToFils(maxNegativeBalanceFils);
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
