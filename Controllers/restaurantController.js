const mongoose = require('mongoose');
const cloudinary = require('../config/cloudinary');
const { Restaurant, validateCreateRestaurant, validateUpdateRestaurant, validateSetRestaurantLocation } = require('../middlewares/Restaurant');
const { Product } = require('../middlewares/Product');
const { Favorite } = require('../middlewares/Favorite');
const { User } = require('../middlewares/User');
const { buildUrl } = require('../config/urlBuilder');
const path = require('path');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRestaurant(restaurant) {
    const obj = restaurant.toObject ? restaurant.toObject() : { ...restaurant };
    obj.agentId = obj.agentId ? obj.agentId.toString() : null;
    obj.agentName = obj.agentName || null;
    return obj;
}

function buildImageUrl(req, filename) {
    if (!filename) return null;
    if (filename.startsWith('http://') || filename.startsWith('https://')) return filename;
    return buildUrl(req, `products/${path.basename(filename)}`);
}

function formatProduct(product, req) {
    const obj = product.toObject ? product.toObject() : { ...product };

    let rawImages = [];
    if (Array.isArray(obj.images) && obj.images.length > 0) {
        rawImages = obj.images;
    } else if (obj.image && typeof obj.image === 'string' && obj.image.trim() !== '') {
        rawImages = [obj.image];
    }
    obj.images = rawImages
        .filter(f => f && f.trim() !== '')
        .map(f => buildImageUrl(req, f));
    delete obj.image;
    return obj;
}

const sanitizeRestaurantPayload = (body) => {
    const data = { ...body };
    if (
        !data.requiredVehicleTypeId ||
        data.requiredVehicleTypeId === '' ||
        data.requiredVehicleTypeId === 'null' ||
        data.requiredVehicleTypeId === 'undefined' ||
        !mongoose.Types.ObjectId.isValid(data.requiredVehicleTypeId)
    ) {
        data.requiredVehicleTypeId = null;
    }
    if (data.requiredVehicleTypeName === '' || data.requiredVehicleTypeName === 'null') {
        data.requiredVehicleTypeName = null;
    }
    if (
        !data.agentId ||
        data.agentId === '' ||
        data.agentId === 'null' ||
        data.agentId === 'undefined' ||
        !mongoose.Types.ObjectId.isValid(data.agentId)
    ) {
        data.agentId = null;
    }
    if (data.agentName === '' || data.agentName === 'null') {
        data.agentName = null;
    }
    if (data.deliveryPricePerMeter === '' || data.deliveryPricePerMeter === 'null' || isNaN(data.deliveryPricePerMeter)) {
        data.deliveryPricePerMeter = null;
    } else if (data.deliveryPricePerMeter !== null && data.deliveryPricePerMeter !== undefined) {
        data.deliveryPricePerMeter = Number(data.deliveryPricePerMeter);
    }
    if (data.deliveryFlatFee === '' || data.deliveryFlatFee === 'null' || isNaN(data.deliveryFlatFee)) {
        data.deliveryFlatFee = null;
    } else if (data.deliveryFlatFee !== null && data.deliveryFlatFee !== undefined) {
        data.deliveryFlatFee = Number(data.deliveryFlatFee);
    }
    if (data.lat === '' || data.lat === 'null' || (data.lat !== undefined && isNaN(data.lat))) {
        data.lat = null;
    } else if (data.lat !== null && data.lat !== undefined) {
        data.lat = Number(data.lat);
    }
    if (data.lng === '' || data.lng === 'null' || (data.lng !== undefined && isNaN(data.lng))) {
        data.lng = null;
    } else if (data.lng !== null && data.lng !== undefined) {
        data.lng = Number(data.lng);
    }
    if (typeof data.pickupLocation === 'string' && data.pickupLocation.trim() !== '') {
        try {
            data.pickupLocation = JSON.parse(data.pickupLocation);
        } catch (_) {}
    }
    return data;
};

function extractPickupLocation(body) {
    if (!body) return null;
    let loc = null;
    if (body.pickupLocation) {
        if (typeof body.pickupLocation === 'string') {
            try {
                loc = JSON.parse(body.pickupLocation);
            } catch (_) {}
        } else if (typeof body.pickupLocation === 'object') {
            loc = body.pickupLocation;
        }
    }
    const rawLat = loc?.lat !== undefined ? loc.lat : body.lat;
    const rawLng = loc?.lng !== undefined ? loc.lng : body.lng;
    const rawAddress = (loc?.address !== undefined ? loc.address : body.address) || '';

    if (
        rawLat !== undefined && rawLat !== null && rawLat !== '' && rawLat !== 'null' &&
        rawLng !== undefined && rawLng !== null && rawLng !== '' && rawLng !== 'null' &&
        !isNaN(Number(rawLat)) && !isNaN(Number(rawLng))
    ) {
        return {
            lat: Number(rawLat),
            lng: Number(rawLng),
            address: typeof rawAddress === 'string' ? rawAddress.trim() : '',
        };
    }
    return null;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * @desc   Create a new restaurant (admin only)
 * @route  POST /api/store/restaurants
 */
const createRestaurant = async (req, res) => {
    const sanitizedBody = sanitizeRestaurantPayload(req.body);
    const { error, value } = validateCreateRestaurant(sanitizedBody);
    if (error) return res.status(400).json({ message: error.details.map(d => d.message).join(', ') });

    if (value.agentId && !value.agentName) {
        try {
            const agentUser = await User.findById(value.agentId).select('storeName fullName firstName lastName').lean();
            if (agentUser) {
                value.agentName = (agentUser.storeName && agentUser.storeName.trim()) ||
                    `${agentUser.firstName || ''} ${agentUser.lastName || ''}`.trim() ||
                    agentUser.fullName ||
                    null;
            }
        } catch (_) {}
    }

    const restaurant = new Restaurant(value);

    // multer-storage-cloudinary sets file.path = full Cloudinary URL
    if (req.file) {
        restaurant.logo = req.file.path;
    }

    const pickupLoc = extractPickupLocation(req.body) || extractPickupLocation(value);
    if (pickupLoc) {
        restaurant.pickupLocation = pickupLoc;
    }

    await restaurant.save();

    res.status(201).json({
        message: 'Restaurant created successfully',
        restaurant: formatRestaurant(restaurant),
    });
};

/**
 * @desc   Get all restaurants (admin sees all; clients see active only)
 * @route  GET /api/store/restaurants
 */
const getAllRestaurants = async (req, res) => {
    const isAdmin = req.user?.isAdmin;
    const { search } = req.query;

    const filter = {};
    if (!isAdmin) {
        filter.isActive = true;
    }

    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
        ];
    }

    const restaurants = await Restaurant.find(filter).sort({ createdAt: -1 });

    // Attach product count per restaurant
    const ids = restaurants.map(r => r._id);
    const productCounts = await Product.aggregate([
        { $match: { restaurantId: { $in: ids }, isActive: true } },
        { $group: { _id: '$restaurantId', count: { $sum: 1 } } },
    ]);
    const countMap = {};
    productCounts.forEach(pc => { countMap[pc._id.toString()] = pc.count; });

    const result = restaurants.map(r => {
        const obj = formatRestaurant(r);
        obj.productCount = countMap[r._id.toString()] || 0;
        return obj;
    });

    res.json({ total: result.length, restaurants: result });
};

/**
 * @desc   Get single restaurant by ID
 * @route  GET /api/store/restaurants/:id
 */
const getRestaurantById = async (req, res) => {
    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

    const isAdmin = req.user?.isAdmin;
    if (!isAdmin && !restaurant.isActive) {
        return res.status(404).json({ message: 'Restaurant not found' });
    }

    const productCount = await Product.countDocuments({
        restaurantId: restaurant._id,
        isActive: true,
    });

    const obj = formatRestaurant(restaurant);
    obj.productCount = productCount;

    res.json(obj);
};

/**
 * @desc   Update restaurant (admin only)
 * @route  PUT /api/store/restaurants/:id
 */
const updateRestaurant = async (req, res) => {
    const sanitizedBody = sanitizeRestaurantPayload(req.body);
    const { error, value } = validateUpdateRestaurant(sanitizedBody);
    if (error) return res.status(400).json({ message: error.details.map(d => d.message).join(', ') });

    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

    // Handle logo replacement
    if (req.file) {
        // Delete old logo from Cloudinary (best-effort)
        if (restaurant.logo) {
            const parts = restaurant.logo.split('/');
            const filenameWithExt = parts[parts.length - 1];
            const filename = filenameWithExt.replace(/\.[^.]+$/, '');
            const folder = parts[parts.length - 2];
            const publicId = `${folder}/${filename}`;
            await cloudinary.uploader.destroy(publicId).catch(() => {});
        }
        value.logo = req.file.path;
    }

    if (value.agentId && !value.agentName) {
        try {
            const agentUser = await User.findById(value.agentId).select('storeName fullName firstName lastName').lean();
            if (agentUser) {
                value.agentName = (agentUser.storeName && agentUser.storeName.trim()) ||
                    `${agentUser.firstName || ''} ${agentUser.lastName || ''}`.trim() ||
                    agentUser.fullName ||
                    null;
            }
        } catch (_) {}
    }

    Object.assign(restaurant, value);

    const pickupLoc = extractPickupLocation(req.body) || extractPickupLocation(value);
    let locationUpdated = false;
    if (pickupLoc) {
        restaurant.pickupLocation = {
            lat: pickupLoc.lat,
            lng: pickupLoc.lng,
            address: pickupLoc.address || restaurant.pickupLocation?.address || '',
        };
        locationUpdated = true;
    }

    await restaurant.save();

    if (locationUpdated && restaurant.pickupLocation && restaurant.pickupLocation.lat != null) {
        await Product.updateMany(
            { restaurantId: restaurant._id },
            { $set: { pickupLocation: restaurant.pickupLocation } }
        );
    }

    res.json({
        message: 'Restaurant updated successfully',
        restaurant: formatRestaurant(restaurant),
    });
};

/**
 * @desc   Delete restaurant (admin only)
 * @route  DELETE /api/store/restaurants/:id
 */
const deleteRestaurant = async (req, res) => {
    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

    // Unlink all products from this restaurant
    await Product.updateMany(
        { restaurantId: restaurant._id },
        { $set: { restaurantId: null } }
    );

    // Delete logo from Cloudinary (best-effort)
    if (restaurant.logo) {
        const parts = restaurant.logo.split('/');
        const filenameWithExt = parts[parts.length - 1];
        const filename = filenameWithExt.replace(/\.[^.]+$/, '');
        const folder = parts[parts.length - 2];
        const publicId = `${folder}/${filename}`;
        await cloudinary.uploader.destroy(publicId).catch(() => {});
    }

    await restaurant.deleteOne();

    res.json({ message: 'Restaurant deleted successfully' });
};

/**
 * @desc   Get all products belonging to a specific restaurant
 * @route  GET /api/store/restaurants/:id/products
 */
const getRestaurantProducts = async (req, res) => {
    const { page = 1, limit = 20, search, isSoldOut } = req.query;

    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

    const isAdmin = req.user?.isAdmin;
    const isAgent = req.user?.userType === 'Agent';
    const isAdminOrAgent = isAdmin || isAgent;
    const userId = req.user?.id;

    if (!isAdmin && !restaurant.isActive) {
        return res.status(404).json({ message: 'Restaurant not found' });
    }

    const filter = { restaurantId: restaurant._id };

    // Clients only see active products
    if (!isAdminOrAgent) {
        filter.isActive = true;
    }

    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
            { category: { $regex: search, $options: 'i' } },
        ];
    }

    if (isSoldOut !== undefined) {
        filter.isSoldOut = isSoldOut === 'true';
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [products, total] = await Promise.all([
        Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
        Product.countDocuments(filter),
    ]);

    // Batch favorited check
    const favoriteIds = new Set();
    if (userId) {
        const favs = await Favorite.find(
            { userId, productId: { $in: products.map(p => p._id) } },
            { productId: 1 }
        );
        favs.forEach(f => favoriteIds.add(f.productId.toString()));
    }

    res.json({
        restaurant: formatRestaurant(restaurant),
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        products: products.map(p => {
            const formatted = formatProduct(p, req);
            formatted.isFavorited = favoriteIds.has(p._id.toString());
            return formatted;
        }),
    });
};

/**
 * @desc   Set / update pickup location for a restaurant (admin only)
 * @route  PATCH /api/store/restaurants/:id/location
 * @body   { lat: Number, lng: Number, address?: String }
 */
const setRestaurantLocation = async (req, res) => {
    const { error, value } = validateSetRestaurantLocation(req.body);
    if (error) return res.status(400).json({ message: error.details.map(d => d.message).join(', ') });

    const restaurant = await Restaurant.findById(req.params.id);
    if (!restaurant) return res.status(404).json({ message: 'Restaurant not found' });

    restaurant.pickupLocation = {
        lat:     value.lat,
        lng:     value.lng,
        address: value.address || '',
    };
    await restaurant.save();

    await Product.updateMany(
        { restaurantId: restaurant._id },
        { $set: { pickupLocation: restaurant.pickupLocation } }
    );

    res.json({
        message: 'Pickup location updated successfully',
        restaurantId: restaurant._id,
        name: restaurant.name,
        pickupLocation: restaurant.pickupLocation,
    });
};

module.exports = {
    createRestaurant,
    getAllRestaurants,
    getRestaurantById,
    updateRestaurant,
    deleteRestaurant,
    getRestaurantProducts,
    setRestaurantLocation,
};
