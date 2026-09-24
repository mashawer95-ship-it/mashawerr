const path = require('path');
const cloudinary = require('../config/cloudinary');
const { Product, validateCreateProduct, validateUpdateProduct, validateUpdateStock } = require('../middlewares/Product');
const { Restaurant } = require('../middlewares/Restaurant');
const { Favorite } = require('../middlewares/Favorite');
const { User } = require('../middlewares/User');
const { buildUrl } = require('../config/urlBuilder');

// ─── Helper ──────────────────────────────────────────────────────────────────

function buildImageUrl(req, filename) {
    if (!filename) return null;
    // If it's already a full URL, return as-is
    if (filename.startsWith('http://') || filename.startsWith('https://')) return filename;
    return buildUrl(req, `products/${path.basename(filename)}`);
}

function formatProduct(product, req, isAdminOrAgent = false) {
    const obj = product.toObject ? product.toObject() : { ...product };

    // Extract association details if populated
    if (obj.associationId && typeof obj.associationId === 'object') {
        obj.associationName = obj.associationId.name || null;
        obj.associationLogo = obj.associationId.logo || null;
        obj.associationId = obj.associationId._id ? obj.associationId._id.toString() : String(obj.associationId);
    }

    // Extract restaurant details if populated
    if (obj.restaurantId && typeof obj.restaurantId === 'object') {
        obj.restaurantName = obj.restaurantId.name || null;
        obj.restaurantLogo = obj.restaurantId.logo || null;
        obj.restaurantId = obj.restaurantId._id ? obj.restaurantId._id.toString() : String(obj.restaurantId);
    }

    obj.addons = Array.isArray(obj.addons) ? obj.addons : [];

    // ── Backward compatibility: old products used a single `image` string field ──
    // Build images array from whichever source has data
    let rawImages = [];

    if (Array.isArray(obj.images) && obj.images.length > 0) {
        rawImages = obj.images;
    } else if (obj.image && typeof obj.image === 'string' && obj.image.trim() !== '') {
        // Legacy single-image field
        rawImages = [obj.image];
    }

    // Build absolute URLs for every image
    obj.images = rawImages
        .filter(f => f && f.trim() !== '')
        .map(f => buildImageUrl(req, f));

    // Remove legacy field to keep response clean
    delete obj.image;

    // Attach computed rating / sold info
    obj.averageRating = obj.averageRating || 0;
    obj.ratingCount = obj.ratingCount || 0;
    obj.totalSold = obj.totalSold || 0;

    // Strip internal/admin fields for non-admin callers
    if (!isAdminOrAgent) {
        delete obj.initialStock;
        delete obj.__v;
    }

    return obj;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * @desc   Create a new product (admin only)
 * @route  POST /api/store/products
 */
const createProduct = async (req, res) => {
    if (typeof req.body.addons === 'string') {
        try {
            req.body.addons = JSON.parse(req.body.addons);
        } catch (_) {
            req.body.addons = [];
        }
    }

    const { error, value } = validateCreateProduct(req.body);
    if (error) return res.status(400).json({ message: error.details.map(d => d.message).join(', ') });

    const product = new Product(value);

    // multer-storage-cloudinary sets file.path = full Cloudinary URL
    if (req.files && req.files.length > 0) {
        product.images = req.files.map(f => f.path);
    }

    // Snapshot initial stock at creation — never changes afterwards
    product.initialStock = product.stock;

    // If product belongs to a restaurant, or created by an agent assigned to a restaurant:
    let matchedRestaurant = null;
    if (product.restaurantId) {
        try {
            matchedRestaurant = await Restaurant.findById(product.restaurantId).lean();
        } catch (_) {}
    } else {
        const effectiveAgentId = product.agentId || (req.user?.userType === 'Agent' ? req.user.id : null);
        if (effectiveAgentId) {
            try {
                matchedRestaurant = await Restaurant.findOne({ agentId: effectiveAgentId }).lean();
                if (matchedRestaurant) {
                    product.restaurantId = matchedRestaurant._id;
                }
            } catch (_) {}
        }
    }

    if (matchedRestaurant) {
        if (!product.agentId && matchedRestaurant.agentId) {
            product.agentId = matchedRestaurant.agentId;
            product.agentName = matchedRestaurant.agentName || null;
        }
        if (!product.requiredVehicleTypeId && matchedRestaurant.requiredVehicleTypeId) {
            product.requiredVehicleTypeId = matchedRestaurant.requiredVehicleTypeId;
            product.requiredVehicleTypeName = matchedRestaurant.requiredVehicleTypeName || null;
        }
        if ((product.deliveryPricePerMeter === undefined || product.deliveryPricePerMeter === null) && matchedRestaurant.deliveryPricePerMeter != null) {
            product.deliveryPricePerMeter = matchedRestaurant.deliveryPricePerMeter;
        }
        if ((product.deliveryFlatFee === undefined || product.deliveryFlatFee === null) && matchedRestaurant.deliveryFlatFee != null) {
            product.deliveryFlatFee = matchedRestaurant.deliveryFlatFee;
        }
        // Inherit restaurant pickup location and lock it!
        if (matchedRestaurant.pickupLocation && matchedRestaurant.pickupLocation.lat != null && matchedRestaurant.pickupLocation.lng != null) {
            product.pickupLocation = {
                lat: Number(matchedRestaurant.pickupLocation.lat),
                lng: Number(matchedRestaurant.pickupLocation.lng),
                address: matchedRestaurant.pickupLocation.address || '',
            };
        }
    }

    if (product.agentId && (!product.agentName || /^[0-9a-fA-F]{24}$/.test(String(product.agentName).trim()))) {
        try {
            const agentUser = await User.findById(product.agentId).select('firstName lastName storeName fullName').lean();
            if (agentUser) {
                product.agentName = (agentUser.storeName && agentUser.storeName.trim()) ||
                    `${agentUser.firstName || ''} ${agentUser.lastName || ''}`.trim() ||
                    agentUser.fullName ||
                    null;
            }
        } catch (_) { }
    }

    // Set pickup location directly if lat/lng are provided in body (only if NOT locked to restaurant location)
    const hasLockedLocation = matchedRestaurant && matchedRestaurant.pickupLocation && matchedRestaurant.pickupLocation.lat != null && matchedRestaurant.pickupLocation.lng != null;
    if (!hasLockedLocation && req.body.lat != null && req.body.lng != null && req.body.lat !== '' && req.body.lng !== '') {
        product.pickupLocation = {
            lat: Number(req.body.lat),
            lng: Number(req.body.lng),
            address: req.body.address || '',
        };
    }

    await product.save();

    res.status(201).json({
        message: 'Product created successfully',
        product: formatProduct(product, req, true),
    });
};

/**
 * @desc   Assign an agent to a product (admin only) — convenience endpoint
 * @route  POST /api/store/products/:id/assign
 */
const assignAgents = async (req, res) => {
    const { agentId, agentName } = req.body;
    if (!agentId) return res.status(400).json({ message: 'agentId is required' });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    product.agentId = agentId;
    let resolvedName = agentName;
    if (!resolvedName || /^[0-9a-fA-F]{24}$/.test(String(resolvedName).trim())) {
        try {
            const agentUser = await User.findById(agentId).select('firstName lastName storeName fullName').lean();
            if (agentUser) {
                resolvedName = (agentUser.storeName && agentUser.storeName.trim()) ||
                    `${agentUser.firstName || ''} ${agentUser.lastName || ''}`.trim() ||
                    agentUser.fullName ||
                    null;
            }
        } catch (_) { }
    }
    product.agentName = resolvedName || null;
    await product.save();

    res.json({
        message: 'Agent assigned successfully',
        product: formatProduct(product, req, true),
    });
};

/**
 * @desc   Get all products (paginated, searchable, filterable)
 *         Admins see all; Agents see their assigned products; Clients see active ones.
 * @route  GET /api/store/products
 */
const getAllProducts = async (req, res) => {
    const { page = 1, limit = 20, search, category, isSoldOut, isActive, associationId, restaurantId } = req.query;
    
    const isAdmin = req.user?.isAdmin;
    const isAgent = req.user?.userType === 'Agent';
    const isAdminOrAgent = isAdmin || isAgent;
    const userId = req.user?.id;

    const filter = {};

    // Filter by association if provided
    if (associationId && associationId !== 'all') {
        if (associationId === 'none' || associationId === 'null') {
            filter.associationId = null;
        } else {
            filter.associationId = associationId;
        }
    }

    // Filter by restaurant if provided
    if (restaurantId && restaurantId !== 'all') {
        if (restaurantId === 'none' || restaurantId === 'null') {
            filter.restaurantId = null;
        } else {
            filter.restaurantId = restaurantId;
        }
    }

    // Ownership logic — agent sees only their own products
    if (isAgent && !isAdmin) {
        filter.agentId = req.user.id;
    }

    // Clients can only see active products
    if (!isAdminOrAgent) {
        filter.isActive = true;
    } else if (isActive !== undefined) {
        filter.isActive = isActive === 'true';
    }

    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
            { category: { $regex: search, $options: 'i' } },
        ];
    }

    if (category) filter.category = { $regex: `^${category}$`, $options: 'i' };

    if (isSoldOut !== undefined) {
        filter.isSoldOut = isSoldOut === 'true';
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [products, total] = await Promise.all([
        Product.find(filter)
            .populate('associationId', 'name logo')
            .populate('restaurantId', 'name logo')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum),
        Product.countDocuments(filter),
    ]);

    // Build a set of favorited product IDs for this user (batch, single query)
    const favoriteIds = new Set();
    if (userId) {
        const favs = await Favorite.find(
            { userId, productId: { $in: products.map(p => p._id) } },
            { productId: 1 }
        );
        favs.forEach(f => favoriteIds.add(f.productId.toString()));
    }

    res.json({
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        products: products.map(p => {
            const formatted = formatProduct(p, req, isAdminOrAgent);
            formatted.isFavorited = favoriteIds.has(p._id.toString());
            return formatted;
        }),
    });
};

/**
 * @desc   Get single product by ID
 * @route  GET /api/store/products/:id
 */
const getProductById = async (req, res) => {
    const product = await Product.findById(req.params.id)
        .populate('associationId', 'name logo')
        .populate('restaurantId', 'name logo');
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const isAdmin = req.user?.isAdmin;
    const isAgent = req.user?.userType === 'Agent';
    const isAdminOrAgent = isAdmin || isAgent;
    const userId = req.user?.id;

    // Agent ownership check (agent sees only their own products)
    if (isAgent && !isAdmin) {
        if (product.agentId !== req.user.id) {
            return res.status(403).json({ message: 'Access denied to this product' });
        }
    }

    // Clients only see active products
    if (!isAdminOrAgent && !product.isActive) {
        return res.status(404).json({ message: 'Product not found' });
    }

    const formatted = formatProduct(product, req, isAdminOrAgent);

    // isFavorited flag
    if (userId) {
        const isFav = await Favorite.exists({ userId, productId: product._id });
        formatted.isFavorited = !!isFav;
    } else {
        formatted.isFavorited = false;
    }

    res.json(formatted);
};

/**
 * @desc   Update product (admin or owning agent)
 * @route  PUT /api/store/products/:id
 */
const updateProduct = async (req, res) => {
    if (typeof req.body.addons === 'string') {
        try {
            req.body.addons = JSON.parse(req.body.addons);
        } catch (_) {
            req.body.addons = [];
        }
    }

    const { error, value } = validateUpdateProduct(req.body);
    if (error) return res.status(400).json({ message: error.details.map(d => d.message).join(', ') });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const isAdmin = req.user?.isAdmin;
    const isAgent = req.user?.userType === 'Agent';

    if (isAgent && !isAdmin) {
        // Enforce ownership
        if (product.agentId !== req.user.id) {
            return res.status(403).json({ message: 'Access denied. You can only update your assigned products.' });
        }
        // Agents cannot reassign ownership
        if (value.agentId !== undefined) {
            return res.status(403).json({ message: 'Agents cannot modify product ownership.' });
        }
    }

    // Remove the replaceImages flag from value before assigning to product
    const replaceImages = value.replaceImages === 'true';
    delete value.replaceImages;

    if (value.deliveryPricePerMeter === '' || value.deliveryPricePerMeter === null) {
        product.deliveryPricePerMeter = undefined;
        delete value.deliveryPricePerMeter;
    }
    if (value.deliveryFlatFee === '' || value.deliveryFlatFee === null) {
        product.deliveryFlatFee = undefined;
        delete value.deliveryFlatFee;
    }

    // Append/replace Cloudinary images
    if (req.files && req.files.length > 0) {
        const newUrls = req.files.map(f => f.path); // f.path = full Cloudinary URL
        if (replaceImages) {
            // Delete old images from Cloudinary
            const oldPublicIds = (product.images || []).map(url => {
                // Extract public_id from Cloudinary URL
                // e.g. https://res.cloudinary.com/xxx/image/upload/v123/mashawerr/products/product-abc
                const parts = url.split('/');
                const filenameWithExt = parts[parts.length - 1];
                const filename = filenameWithExt.replace(/\.[^.]+$/, ''); // remove extension
                const folder = parts[parts.length - 2];
                return `${folder}/${filename}`;
            }).filter(Boolean);
            if (oldPublicIds.length > 0) {
                await cloudinary.api.delete_resources(oldPublicIds).catch(() => {}); // best-effort
            }
            value.images = newUrls;
        } else {
            // Append to existing images
            value.images = [...(product.images || []), ...newUrls];
        }
    }

    Object.assign(product, value);

    // If product belongs to a restaurant, or updated by an agent assigned to a restaurant:
    let matchedRestaurant = null;
    if (product.restaurantId) {
        try {
            matchedRestaurant = await Restaurant.findById(product.restaurantId).lean();
        } catch (_) {}
    } else {
        const effectiveAgentId = product.agentId || (req.user?.userType === 'Agent' ? req.user.id : null);
        if (effectiveAgentId) {
            try {
                matchedRestaurant = await Restaurant.findOne({ agentId: effectiveAgentId }).lean();
                if (matchedRestaurant) {
                    product.restaurantId = matchedRestaurant._id;
                }
            } catch (_) {}
        }
    }

    if (matchedRestaurant) {
        if (!product.agentId && matchedRestaurant.agentId) {
            product.agentId = matchedRestaurant.agentId;
            product.agentName = matchedRestaurant.agentName || null;
        }
        if (!product.requiredVehicleTypeId && matchedRestaurant.requiredVehicleTypeId) {
            product.requiredVehicleTypeId = matchedRestaurant.requiredVehicleTypeId;
            product.requiredVehicleTypeName = matchedRestaurant.requiredVehicleTypeName || null;
        }
        if ((product.deliveryPricePerMeter === undefined || product.deliveryPricePerMeter === null) && matchedRestaurant.deliveryPricePerMeter != null) {
            product.deliveryPricePerMeter = matchedRestaurant.deliveryPricePerMeter;
        }
        if ((product.deliveryFlatFee === undefined || product.deliveryFlatFee === null) && matchedRestaurant.deliveryFlatFee != null) {
            product.deliveryFlatFee = matchedRestaurant.deliveryFlatFee;
        }
        // Inherit restaurant pickup location and lock it!
        if (matchedRestaurant.pickupLocation && matchedRestaurant.pickupLocation.lat != null && matchedRestaurant.pickupLocation.lng != null) {
            product.pickupLocation = {
                lat: Number(matchedRestaurant.pickupLocation.lat),
                lng: Number(matchedRestaurant.pickupLocation.lng),
                address: matchedRestaurant.pickupLocation.address || '',
            };
        }
    }

    if (product.agentId && (!product.agentName || /^[0-9a-fA-F]{24}$/.test(String(product.agentName).trim()))) {
        try {
            const agentUser = await User.findById(product.agentId).select('firstName lastName storeName fullName').lean();
            if (agentUser) {
                product.agentName = (agentUser.storeName && agentUser.storeName.trim()) ||
                    `${agentUser.firstName || ''} ${agentUser.lastName || ''}`.trim() ||
                    agentUser.fullName ||
                    null;
            }
        } catch (_) { }
    }

    // Set pickup location directly if lat/lng are provided in body (only if NOT locked to restaurant location)
    const hasLockedLocation = matchedRestaurant && matchedRestaurant.pickupLocation && matchedRestaurant.pickupLocation.lat != null && matchedRestaurant.pickupLocation.lng != null;
    if (!hasLockedLocation && req.body.lat != null && req.body.lng != null && req.body.lat !== '' && req.body.lng !== '') {
        product.pickupLocation = {
            lat: Number(req.body.lat),
            lng: Number(req.body.lng),
            address: req.body.address || product.pickupLocation?.address || '',
        };
    }

    await product.save(); // triggers pre-save for isSoldOut

    res.json({
        message: 'Product updated successfully',
        product: formatProduct(product, req, true),
    });
};

/**
 * @desc   Delete product (admin only)
 * @route  DELETE /api/store/products/:id
 */
const deleteProduct = async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    // Hard delete
    await product.deleteOne();

    res.json({ message: 'Product deleted successfully' });
};

/**
 * @desc   Update stock manually (admin or owning agent)
 * @route  PATCH /api/store/products/:id/stock
 */
const updateStock = async (req, res) => {
    const { error, value } = validateUpdateStock(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const isAdmin = req.user?.isAdmin;
    const isAgent = req.user?.userType === 'Agent';

    if (isAgent && !isAdmin) {
        if (product.agentId !== req.user.id) {
            return res.status(403).json({ message: 'Access denied. You can only update your assigned products.' });
        }
    }

    const oldStock = product.stock;
    const newStock = value.stock;
    const added = newStock > oldStock ? (newStock - oldStock) : 0;
    const isSoldOut = newStock <= 0;

    const updateOps = {
        $set: {
            stock: newStock,
            isSoldOut,
        },
    };
    if (added > 0) {
        updateOps.$inc = { initialStock: added };
    }

    const updatedProduct = await Product.findByIdAndUpdate(
        product._id,
        updateOps,
        { new: true }
    );

    res.json({
        message: 'Stock updated successfully',
        productId: updatedProduct._id,
        name: updatedProduct.name,
        stock: updatedProduct.stock,
        initialStock: updatedProduct.initialStock,
        totalSold: updatedProduct.totalSold,
        isSoldOut: updatedProduct.isSoldOut,
    });
};

/**
 * @desc   Get all categories (distinct values from DB)
 * @route  GET /api/store/products/categories
 */
const getCategories = async (req, res) => {
    const categories = await Product.distinct('category', { isActive: true });
    res.json({ categories });
};

/**
 * @desc   Get best-selling products (sorted by totalSold desc)
 * @route  GET /api/store/products/best-sellers
 */
const getBestSellers = async (req, res) => {
    const { limit = 10 } = req.query;
    const isAdmin = req.user?.isAdmin;
    const isAgent = req.user?.userType === 'Agent';
    const isAdminOrAgent = isAdmin || isAgent;
    const userId = req.user?.id;

    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));

    const filter = isAdminOrAgent ? {} : { isActive: true, isSoldOut: false };
    if (isAgent && !isAdmin) filter.agentId = req.user.id;

    const products = await Product.find(filter)
        .populate('associationId', 'name logo')
        .sort({ totalSold: -1, averageRating: -1, createdAt: -1 })
        .limit(limitNum);

    // isFavorited batch check
    const favoriteIds = new Set();
    if (userId) {
        const favs = await Favorite.find(
            { userId, productId: { $in: products.map(p => p._id) } },
            { productId: 1 }
        );
        favs.forEach(f => favoriteIds.add(f.productId.toString()));
    }

    res.json({
        total: products.length,
        products: products.map((p, index) => {
            const formatted = formatProduct(p, req, isAdminOrAgent);
            formatted.isFavorited = favoriteIds.has(p._id.toString());
            formatted.rank = index + 1; // best-seller rank (#1 = most sold)
            return formatted;
        }),
    });
};

/**
 * @desc   Set / update pickup location for a product (agent or admin)
 * @route  PATCH /api/store/products/:id/pickup-location
 * @body   { lat: Number, lng: Number, address?: String }
 */
const setPickupLocation = async (req, res) => {
    const { lat, lng, address = '' } = req.body;

    if (typeof lat !== 'number' || typeof lng !== 'number') {
        return res.status(400).json({ message: 'lat and lng are required numbers' });
    }
    if (lat < -90 || lat > 90)   return res.status(400).json({ message: 'lat must be between -90 and 90' });
    if (lng < -180 || lng > 180) return res.status(400).json({ message: 'lng must be between -180 and 180' });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    // If product belongs to a restaurant that has a pickup location, lock it!
    if (product.restaurantId) {
        try {
            const rest = await Restaurant.findById(product.restaurantId).select('pickupLocation name').lean();
            if (rest && rest.pickupLocation && rest.pickupLocation.lat != null && rest.pickupLocation.lng != null) {
                return res.status(400).json({
                    message: 'موقع الاستلام لهذا المنتج مثبت تلقائياً وفقاً لموقع المطعم وغير قابل للتعديل.',
                    locked: true,
                    pickupLocation: rest.pickupLocation,
                });
            }
        } catch (_) {}
    }

    // Agents can only update their own products
    const isAgent = req.user?.userType === 'Agent';
    const isAdmin = req.user?.isAdmin;
    if (isAgent && !isAdmin && product.agentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. You can only update your own products.' });
    }

    product.pickupLocation = { lat, lng, address };
    await product.save();

    res.json({
        message: 'Pickup location updated successfully',
        productId: product._id,
        name: product.name,
        pickupLocation: product.pickupLocation,
    });
};

const clearOverridesTemporary = async (req, res) => {
    try {
        // Clear deliveryPricePerMeter from ALL products
        const result = await Product.updateMany(
            {},
            { $unset: { deliveryPricePerMeter: 1 } }
        );
        console.log(`[ClearOverrides] Cleared deliveryPricePerMeter from ${result.modifiedCount} products`);
        res.json({
            message: 'Done! deliveryPricePerMeter cleared from all products. Next order will use distance-based pricing.',
            productsModified: result.modifiedCount
        });
    } catch (err) {
        console.error('[ClearOverrides] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
};

module.exports = {
    createProduct,
    assignAgents,
    getAllProducts,
    getProductById,
    updateProduct,
    deleteProduct,
    updateStock,
    getCategories,
    getBestSellers,
    setPickupLocation,
    clearOverridesTemporary
};
