const path = require('path');
const { Favorite } = require('../middlewares/Favorite');
const { Product } = require('../middlewares/Product');
const { buildUrl } = require('../config/urlBuilder');

// ─── Helper ───────────────────────────────────────────────────────────────────

function buildImageUrl(req, filename) {
    if (!filename) return null;
    if (filename.startsWith('http://') || filename.startsWith('https://')) return filename;
    return buildUrl(req, `products/${path.basename(filename)}`);
}

function formatProductForFavorite(product, req) {
    const obj = product.toObject ? product.toObject() : { ...product };

    let rawImages = [];
    if (Array.isArray(obj.images) && obj.images.length > 0) rawImages = obj.images;
    else if (obj.image && typeof obj.image === 'string' && obj.image.trim() !== '') rawImages = [obj.image];

    obj.images = rawImages
        .filter(f => f && f.trim() !== '')
        .map(f => buildImageUrl(req, f));

    delete obj.image;
    obj.isFavorited = true; // all results are by definition favorites
    return obj;
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * @desc   Toggle favorite — add if not exists, remove if exists
 * @route  POST /api/store/favorites/:productId
 */
const toggleFavorite = async (req, res) => {
    const { productId } = req.params;
    const userId = req.user.id;

    // Verify product exists and is active
    const product = await Product.findById(productId);
    if (!product || !product.isActive) {
        return res.status(404).json({ message: 'Product not found' });
    }

    const existing = await Favorite.findOne({ userId, productId });
    if (existing) {
        await existing.deleteOne();
        return res.json({ message: 'Removed from favorites', isFavorited: false });
    }

    await Favorite.create({ userId, productId });
    return res.json({ message: 'Added to favorites', isFavorited: true });
};

/**
 * @desc   Get current user's favorited products
 * @route  GET /api/store/favorites
 */
const getMyFavorites = async (req, res) => {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [favorites, total] = await Promise.all([
        Favorite.find({ userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .populate({ path: 'productId', match: { isActive: true } }),
        Favorite.countDocuments({ userId }),
    ]);

    // Filter out null results (products that became inactive or deleted)
    const products = favorites
        .filter(f => f.productId)
        .map(f => formatProductForFavorite(f.productId, req));

    res.json({
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        products,
    });
};

/**
 * @desc   Get the favorite status of a specific product for the current user
 * @route  GET /api/store/favorites/check/:productId
 */
const checkFavorite = async (req, res) => {
    const { productId } = req.params;
    const userId = req.user.id;

    const exists = await Favorite.exists({ userId, productId });
    res.json({ productId, isFavorited: !!exists });
};

module.exports = { toggleFavorite, getMyFavorites, checkFavorite };
