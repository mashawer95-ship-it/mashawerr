const mongoose = require('mongoose');
const { Rating, validateRating } = require('../middlewares/Rating');
const { Product } = require('../middlewares/Product');
const { StoreOrder } = require('../middlewares/StoreOrder');

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * @desc   Submit or update a rating for a product (must have purchased it)
 * @route  POST /api/store/products/:id/rate
 */
const rateProduct = async (req, res) => {
    const { error, value } = validateRating(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const productId = req.params.id;
    const userId = req.user.id;

    // Validate product exists
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    // Must have a non-cancelled store order containing this product
    const hasPurchased = await StoreOrder.exists({
        userId,
        'items.product': new mongoose.Types.ObjectId(productId),
        status: { $in: ['confirmed', 'processing', 'shipped', 'delivered'] },
    });
    if (!hasPurchased) {
        return res.status(403).json({
            message: 'You can only rate products you have purchased',
        });
    }

    const alreadyRated = await Rating.exists({ userId, productId });

    // Upsert: one rating per user per product
    await Rating.findOneAndUpdate(
        { userId, productId },
        { rating: value.rating, comment: value.comment },
        { upsert: true, new: true }
    );

    // Recalculate product's average rating from all ratings
    const [stats] = await Rating.aggregate([
        { $match: { productId: product._id } },
        {
            $group: {
                _id: null,
                avg: { $avg: '$rating' },
                count: { $sum: 1 },
            },
        },
    ]);

    if (stats) {
        product.averageRating = Math.round(stats.avg * 10) / 10; // 1 decimal place
        product.ratingCount = stats.count;
        await product.save();
    }

    res.status(alreadyRated ? 200 : 201).json({
        message: alreadyRated ? 'Rating updated successfully' : 'Rating submitted successfully',
        productId,
        averageRating: product.averageRating,
        ratingCount: product.ratingCount,
        yourRating: value.rating,
        yourComment: value.comment,
    });
};

/**
 * @desc   Get all ratings/reviews for a product
 * @route  GET /api/store/products/:id/ratings
 */
const getProductRatings = async (req, res) => {
    const productId = req.params.id;
    const { page = 1, limit = 20 } = req.query;

    const product = await Product.findById(productId).select('name averageRating ratingCount');
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [ratings, total] = await Promise.all([
        Rating.find({ productId }).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
        Rating.countDocuments({ productId }),
    ]);

    // Star distribution (5★ → 1★)
    const distribution = await Rating.aggregate([
        { $match: { productId: product._id } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
        { $sort: { _id: -1 } },
    ]);

    // If the user is logged in, return their own rating too
    let myRating = null;
    if (req.user?.id) {
        myRating = await Rating.findOne({ userId: req.user.id, productId }).select('rating comment');
    }

    res.json({
        productId,
        productName: product.name,
        averageRating: product.averageRating,
        ratingCount: product.ratingCount,
        distribution: distribution.map(d => ({ stars: d._id, count: d.count })),
        myRating: myRating || null,
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        ratings,
    });
};

module.exports = { rateProduct, getProductRatings };
