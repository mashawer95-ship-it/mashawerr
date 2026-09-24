const asyncHandler = require('express-async-handler');
const {
    getOrCreateStorePricing,
    validateCalculateStorePricing,
    validateUpdateStorePricing,
    calculateHaversineDistance,
    deduplicateLocations,
    kdToFils,
    filsToKd,
    filsToArabicName,
} = require('../middlewares/StorePricing');
// Removed calculateRoute import as pricing estimation now uses Haversine exclusively


function pricingToFilsResponse(pricing) {
    const baseFare = kdToFils(pricing.baseFare);
    const pricePerMeter = kdToFils(pricing.pricePerMeter);
    const minFare = kdToFils(pricing.minFare);
    return {
        baseFare,
        baseFare_name_ar: filsToArabicName(baseFare),
        pricePerMeter,
        pricePerMeter_name_ar: `سعر المتر: ${filsToArabicName(pricePerMeter)}`,
        minFare,
        minFare_name_ar: filsToArabicName(minFare),
        surgeMultiplier: pricing.surgeMultiplier,
        updatedAt: pricing.updatedAt,
    };
}

/**
 * @description Get current store delivery pricing configuration
 * @route GET /api/store/pricing
 * @access Private (JWT)
 */
const getStorePricing = asyncHandler(async (req, res) => {
    const pricing = await getOrCreateStorePricing();
    return res.status(200).json(pricingToFilsResponse(pricing));
});

/**
 * @description Update store delivery pricing configuration (partial). Values in fils.
 * @route PUT /api/store/pricing
 * @access Private (JWT Admin)
 */
const updateStorePricing = asyncHandler(async (req, res) => {
    const { error } = validateUpdateStorePricing(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { baseFare, pricePerMeter, minFare, surgeMultiplier } = req.body;
    let pricing = await getOrCreateStorePricing();

    if (baseFare !== undefined) pricing.baseFare = filsToKd(baseFare);
    if (pricePerMeter !== undefined) pricing.pricePerMeter = filsToKd(pricePerMeter);
    if (minFare !== undefined) pricing.minFare = filsToKd(minFare);
    if (surgeMultiplier !== undefined) pricing.surgeMultiplier = surgeMultiplier;
    pricing.updatedAt = new Date();

    await pricing.save();

    return res.status(200).json({
        message: 'Store delivery pricing updated successfully',
        pricing: pricingToFilsResponse(pricing),
    });
});

/**
 * @description Calculate store delivery price based on unique pickups and deliveries
 * @route POST /api/store/pricing/calculate
 * @access Private (JWT)
 */
const calculateDeliveryPrice = asyncHandler(async (req, res) => {
    const { error } = validateCalculateStorePricing(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { distance_meters, pickups = [], deliveries = [], overridePricePerMeterFils, overrideFlatFeeFils } = req.body;
    
    let totalDistance = 0;
    const uniquePickups = deduplicateLocations(pickups);
    const uniqueDeliveries = deduplicateLocations(deliveries);

    if (distance_meters !== undefined && distance_meters !== null) {
        // EXACTLY like normal orders: client provides the calculated distance (e.g. from Google Directions API drawn route)
        totalDistance = distance_meters;
        console.log(`[StorePricing] Received direct distance_meters from client: ${totalDistance}m`);
    } else {
        // Fallback: Calculate estimated distance based on locations if distance_meters is not provided
        console.log(`[StorePricing] Received ${pickups.length} pickups, ${deliveries.length} deliveries`);
        pickups.forEach((p, i) => console.log(`  pickup[${i}]: lat=${p.lat}, lng=${p.lng}`));
        deliveries.forEach((d, i) => console.log(`  delivery[${i}]: lat=${d.lat}, lng=${d.lng}`));
        console.log(`[StorePricing] After dedup: ${uniquePickups.length} pickups, ${uniqueDeliveries.length} deliveries`);
        
        const allLocations = [...uniquePickups, ...uniqueDeliveries];
        if (allLocations.length >= 2) {
            // Use Haversine distance for pricing estimation to avoid massive Google Routes API costs during cart polling
            // Apply a 1.3 multiplier to approximate actual road distance
            for (let i = 0; i < allLocations.length - 1; i++) {
                let dist = calculateHaversineDistance(
                    allLocations[i].lat, allLocations[i].lng,
                    allLocations[i+1].lat, allLocations[i+1].lng
                );
                totalDistance += dist;
            }
            totalDistance = Math.round(totalDistance * 1.3); // Apply route factor and round to nearest meter
            console.log(`[StorePricing] Estimated Distance (Haversine * 1.3): ${totalDistance}m`);
        }
    }

    const pricing = await getOrCreateStorePricing();
    let totalPriceKD = 0;

    if (overrideFlatFeeFils !== undefined && overrideFlatFeeFils !== null) {
        // FLAT delivery fee override (admin-set per-product fee in fils → KD)
        totalPriceKD = filsToKd(overrideFlatFeeFils);
        console.log(`[StorePricing] FLAT override: ${overrideFlatFeeFils} fils = ${totalPriceKD} KD. Distance ignored.`);
    } else {
        // ✅ IDENTICAL formula to normal delivery (pricingController.js):
        //    totalPrice = baseFare + (distance_meters * pricePerMeter)
        
        // If product has a custom pricePerMeter override, use it instead of the global one.
        let actualPricePerMeter = pricing.pricePerMeter;
        if (overridePricePerMeterFils !== undefined && overridePricePerMeterFils !== null) {
            actualPricePerMeter = filsToKd(overridePricePerMeterFils);
            console.log(`[StorePricing] PER METER override: ${overridePricePerMeterFils} fils = ${actualPricePerMeter} KD/m.`);
        }

        totalPriceKD = pricing.baseFare + (totalDistance * actualPricePerMeter);
        console.log(`[StorePricing] distance=${totalDistance}m, pricePerMeter=${actualPricePerMeter}KD, baseFare=${pricing.baseFare}KD → priceBeforeSurge=${totalPriceKD}KD`);
    }

    totalPriceKD = totalPriceKD * pricing.surgeMultiplier;

    if (totalPriceKD < pricing.minFare) {
        totalPriceKD = pricing.minFare;
    }

    const priceFils = kdToFils(totalPriceKD);
    const priceKD = Number((priceFils / 1000).toFixed(3));
    console.log(`[StorePricing] Final: ${priceFils} fils (${priceKD} KD)`);

    return res.status(200).json({
        distance_meters: totalDistance,
        price: priceFils,
        priceKD,
        priceFils,
        name_ar: filsToArabicName(priceFils),
        uniquePickupsCount: uniquePickups.length,
        uniqueDeliveriesCount: uniqueDeliveries.length
    });
});

module.exports = {
    getStorePricing,
    updateStorePricing,
    calculateDeliveryPrice
};
