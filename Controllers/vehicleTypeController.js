const asyncHandler = require('express-async-handler');
const {
    VehicleType,
    validateCreateVehicleType,
    validateUpdateVehicleType,
    validateCalculatePrice,
} = require('../middlewares/VehicleType');
const { kdToFils, filsToKd, filsToArabicName } = require('../middlewares/Pricing');
const { calculateRoute } = require('../services/googleRoutesService');

function normalizeEgpInput(value, defaultValue = 0) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const n = Number(value);
    if (isNaN(n) || n < 0) return defaultValue;
    // إذا أرسل المستخدم قيمة قديمة بالفلس (أكبر من أو تساوي 500)، يتم تحويلها تلقائياً إلى جنيه
    if (n >= 500) {
        return Number((n / 1000).toFixed(4));
    }
    return Number(n.toFixed(4));
}

function normalizeMeterPrice(value, defaultValue = 0) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const n = Number(value);
    if (isNaN(n) || n < 0) return defaultValue;
    // إذا أدخل المستخدم سعر الكيلومتر (مثلاً 5 أو 7 أو 10 ج.م للكيلو) وهو >= 1، يتم تحويله لسعر المتر (قسمة على 1000)
    if (n >= 1) {
        return Number((n / 1000).toFixed(6));
    }
    return Number(n.toFixed(6));
}

function vehicleTypeToResponse(vt) {
    const baseFare = Number((vt.baseFare || 0).toFixed(2));
    const pricePerMeter = Number((vt.pricePerMeter || 0).toFixed(6));
    const pricePerKm = Number((pricePerMeter * 1000).toFixed(2));
    const minFare = Number((vt.minFare || 0).toFixed(2));
    const iconKey = vt.icon_key || vt.iconKey || 'sedan';
    
    return {
        _id: vt._id,
        name_ar: vt.name_ar,
        name_en: vt.name_en,
        image: vt.image,
        icon_key: iconKey,
        iconKey: iconKey,
        category: vt.category || 'both',
        isActive: vt.isActive,
        baseFare,
        baseFare_name_ar: `${baseFare} ج.م`,
        pricePerMeter,
        pricePerKm,
        pricePerMeter_name_ar: `سعر الكيلو: ${pricePerKm} ج.م (سعر المتر: ${pricePerMeter} ج.م)`,
        minFare,
        minFare_name_ar: `${minFare} ج.م`,
        surgeMultiplier: vt.surgeMultiplier || 1,
        createdAt: vt.createdAt,
        updatedAt: vt.updatedAt,
    };
}

/**
 * @description Create a new vehicle type
 * @route POST /api/vehicle-types
 * @access Private (Admin)
 */
const createVehicleType = asyncHandler(async (req, res) => {
    if (req.file) {
        req.body.image = req.file.path;
    }

    const { error, value } = validateCreateVehicleType(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const {
        name_ar,
        name_en,
        icon_key,
        iconKey,
        baseFare = 0,
        pricePerMeter = 0,
        minFare = 0,
        surgeMultiplier = 1,
        category = 'both',
        isActive = true,
    } = value;

    const vehicleType = await VehicleType.create({
        name_ar,
        name_en: name_en || undefined,
        image: value.image || req.body.image || undefined,
        icon_key: icon_key || iconKey || 'sedan',
        baseFare: normalizeEgpInput(baseFare, 0),
        pricePerMeter: normalizeMeterPrice(pricePerMeter, 0),
        minFare: normalizeEgpInput(minFare, 0),
        surgeMultiplier: surgeMultiplier !== undefined ? Number(surgeMultiplier) : 1,
        category: category || 'both',
        isActive: isActive !== undefined ? Boolean(isActive) : true,
    });

    return res.status(201).json({
        message: 'Vehicle type created successfully',
        vehicleType: vehicleTypeToResponse(vehicleType),
    });
});

/**
 * @description Update a vehicle type
 * @route PUT /api/vehicle-types/:id
 * @access Private (Admin)
 */
const updateVehicleType = asyncHandler(async (req, res) => {
    if (req.file) {
        req.body.image = req.file.path;
    }

    const { error, value } = validateUpdateVehicleType(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const vehicleType = await VehicleType.findById(req.params.id);
    if (!vehicleType) {
        return res.status(404).json({ message: 'Vehicle type not found' });
    }

    const {
        name_ar,
        name_en,
        icon_key,
        iconKey,
        baseFare,
        pricePerMeter,
        minFare,
        surgeMultiplier,
        category,
        isActive,
    } = value;

    if (name_ar !== undefined) vehicleType.name_ar = name_ar;
    if (name_en !== undefined) vehicleType.name_en = name_en;
    if (icon_key !== undefined || iconKey !== undefined) vehicleType.icon_key = icon_key || iconKey;
    if (value.image !== undefined) vehicleType.image = value.image;
    if (baseFare !== undefined) vehicleType.baseFare = normalizeEgpInput(baseFare, vehicleType.baseFare);
    if (pricePerMeter !== undefined) vehicleType.pricePerMeter = normalizeMeterPrice(pricePerMeter, vehicleType.pricePerMeter);
    if (minFare !== undefined) vehicleType.minFare = normalizeEgpInput(minFare, vehicleType.minFare);
    if (surgeMultiplier !== undefined) vehicleType.surgeMultiplier = Number(surgeMultiplier);
    if (category !== undefined) vehicleType.category = category;
    if (isActive !== undefined) vehicleType.isActive = Boolean(isActive);

    await vehicleType.save();

    return res.status(200).json({
        message: 'Vehicle type updated successfully',
        vehicleType: vehicleTypeToResponse(vehicleType),
    });
});

/** Default Delivery Vehicle Types seed list */
const DEFAULT_DELIVERY_TYPES = [
    { name_ar: 'ملاكي', category: 'delivery', icon_key: 'sedan' },
    { name_ar: 'موتوسيكل', category: 'delivery', icon_key: 'motorcycle' },
    { name_ar: 'هاف لوري صغير', category: 'delivery', icon_key: 'pickup' },
    { name_ar: 'هاف لوري كبير', category: 'delivery', icon_key: 'truck' },
    { name_ar: 'فان بضائع', category: 'delivery', icon_key: 'van' },
];

/**
 * @description Get all vehicle types (filtered by active status)
 * @route GET /api/vehicle-types
 * @access Public / Private (JWT)
 */
const getVehicleTypes = asyncHandler(async (req, res) => {
    // Optionally filter by isActive if requested, else return all
    const filter = {};
    if (req.query.active === 'true') filter.isActive = true;

    const rawDbList = await VehicleType.find(filter).sort({ createdAt: -1 });
    const vehicleTypesList = rawDbList.map(vehicleTypeToResponse);

    return res.status(200).json(vehicleTypesList);
});



/**
 * @description Delete a vehicle type
 * @route DELETE /api/vehicle-types/:id
 * @access Private (Admin)
 */
const deleteVehicleType = asyncHandler(async (req, res) => {
    const vehicleType = await VehicleType.findById(req.params.id);
    if (!vehicleType) {
        return res.status(404).json({ message: 'Vehicle type not found' });
    }

    await vehicleType.deleteOne();

    return res.status(200).json({ message: 'Vehicle type deleted successfully' });
});

/**
 * @description Calculate ride prices based on distance for all active vehicle types
 * @route POST /api/vehicle-types/calculate-price
 * @access Public / Private (JWT)
 */
const calculateVehiclePrices = asyncHandler(async (req, res) => {
    const { error } = validateCalculatePrice(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { locations, tasks } = req.body;
    
    // 1. Calculate Route from Google Routes API
    let distance_meters = 0;
    let durationSeconds = 0;
    let encodedPolyline = null;
    let legPolylines = [];
    let numberOfTasks = 1;

    try {
        if (tasks && tasks.length > 0) {
            numberOfTasks = tasks.length;
            
            // Get individual distances and sum them for accurate pricing
            const taskPromises = tasks.map(async (task) => {
                if (task.fromLatitude && task.fromLongitude && task.toLatitude && task.toLongitude) {
                    const tOrigin = { lat: task.fromLatitude, lng: task.fromLongitude };
                    const tDest = { lat: task.toLatitude, lng: task.toLongitude };
                    try {
                        // Distance-only call for pricing accuracy — use cache where possible.
                        // geohash precision=9 (≈2.4m) ensures each unique origin/dest
                        // pair gets its own cache key, so cached results are always accurate.
                        const tRoute = await calculateRoute(tOrigin, tDest, {});
                        if (tRoute && tRoute.distanceMeters) {
                            return tRoute.distanceMeters;
                        }
                    } catch (e) {
                        console.error('Error calculating individual task route in calculateVehiclePrices:', e.message);
                    }
                }
                return 0;
            });
            
            const taskDistances = await Promise.all(taskPromises);
            distance_meters = taskDistances.reduce((a, b) => a + b, 0);

            // Use 'locations' for the visual route polyline if provided, to avoid zigzag routes
            if (locations && locations.length >= 2) {
                const origin = locations[0];
                const destination = locations[locations.length - 1];
                const intermediates = locations.slice(1, -1);
                
                const routeData = await calculateRoute(origin, destination, { intermediates });
                if (routeData) {
                    durationSeconds = routeData.durationSeconds || 0;
                    encodedPolyline = routeData.encodedPolyline || null;
                    legPolylines = routeData.legPolylines || [];
                }
            } else {
                // Fallback to building waypoints from tasks
                const waypoints = [];
                tasks.forEach((task) => {
                    if (task.fromLatitude && task.fromLongitude) {
                        const lastWp = waypoints[waypoints.length - 1];
                        if (!lastWp || lastWp.lat !== task.fromLatitude || lastWp.lng !== task.fromLongitude) {
                            waypoints.push({ lat: task.fromLatitude, lng: task.fromLongitude });
                        }
                    }
                    if (task.toLatitude && task.toLongitude) {
                        const lastWp = waypoints[waypoints.length - 1];
                        if (!lastWp || lastWp.lat !== task.toLatitude || lastWp.lng !== task.toLongitude) {
                            waypoints.push({ lat: task.toLatitude, lng: task.toLongitude });
                        }
                    }
                });

                if (waypoints.length >= 2) {
                    const origin = waypoints[0];
                    const destination = waypoints[waypoints.length - 1];
                    const intermediates = waypoints.slice(1, -1);
                    
                    const routeData = await calculateRoute(origin, destination, { intermediates });
                    if (routeData) {
                        durationSeconds = routeData.durationSeconds || 0;
                        encodedPolyline = routeData.encodedPolyline || null;
                        legPolylines = routeData.legPolylines || [];
                    }
                }
            }
        } else if (locations && locations.length >= 2) {
            const origin = locations[0];
            const destination = locations[locations.length - 1];
            const intermediates = locations.slice(1, -1);
            
            const routeData = await calculateRoute(origin, destination, { intermediates });
            if (routeData) {
                distance_meters = routeData.distanceMeters || 0;
                durationSeconds = routeData.durationSeconds || 0;
                encodedPolyline = routeData.encodedPolyline || null;
                legPolylines = routeData.legPolylines || [];
            }
        } else {
            return res.status(400).json({ message: 'At least two locations or one task are required' });
        }
    } catch (err) {
        console.error('Error calculating route in calculateVehiclePrices:', err);
        return res.status(400).json({ message: 'Failed to calculate route from Google API' });
    }

    // 2. Only calculate for active vehicle types
    const vehicleTypes = await VehicleType.find({ isActive: true });

    const results = vehicleTypes.map((vt) => {
        // Base fare + distance * price per meter (in Egyptian Pounds)
        let totalPriceEGP = (vt.baseFare * numberOfTasks) + (distance_meters * vt.pricePerMeter);
        
        // Ensure minimum fare
        if (totalPriceEGP < vt.minFare) {
            totalPriceEGP = vt.minFare;
        }

        // Apply surge multiplier
        totalPriceEGP = totalPriceEGP * vt.surgeMultiplier;

        const priceFils = kdToFils(totalPriceEGP);

        return {
            vehicleType: vehicleTypeToResponse(vt),
            price: priceFils,
            price_egp: Number(totalPriceEGP.toFixed(2)),
            name_ar: `${Number(totalPriceEGP.toFixed(2))} ج.م`,
        };
    });

    return res.status(200).json({
        distanceMeters: distance_meters,
        durationSeconds,
        encodedPolyline,
        legPolylines,
        results,
    });
});

module.exports = {
    createVehicleType,
    updateVehicleType,
    getVehicleTypes,
    deleteVehicleType,
    calculateVehiclePrices,
};
