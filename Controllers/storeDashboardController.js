const asyncHandler = require('express-async-handler');
const path = require('path');
const { Product } = require('../middlewares/Product');
const { StoreOrder } = require('../middlewares/StoreOrder');
const { buildUrl } = require('../config/urlBuilder');

// ─── Helper ───────────────────────────────────────────────────────────────────

function buildImageUrl(req, filename) {
    if (!filename) return null;
    if (filename.startsWith('http://') || filename.startsWith('https://')) return filename;
    return buildUrl(req, `products/${path.basename(filename)}`);
}

function getFirstImage(product, req) {
    const imgs = Array.isArray(product.images) && product.images.length > 0
        ? product.images
        : (product.image ? [product.image] : []);
    const first = imgs[0];
    return first ? buildImageUrl(req, first) : null;
}

/**
 * Formats a product into a compact stats summary for dashboard views.
 * initialStock: stock when product was added.
 * stock:        current remaining stock.
 * totalSold:    units sold since it was added.
 * soldPercent:  % of initialStock that has been sold.
 */
function formatProductStats(product, req) {
    const initial = product.initialStock ?? product.stock; // fallback for pre-feature products
    const sold = product.totalSold ?? 0;
    const soldPercent = initial > 0 ? Math.round((sold / initial) * 100) : 0;

    return {
        _id: product._id,
        name: product.name,
        category: product.category,
        price: product.price,
        image: getFirstImage(product, req),
        agentId: product.agentId || null,
        agentName: product.agentName || null,
        isActive: product.isActive,
        isSoldOut: product.isSoldOut,
        // ─── Stock & Sales Stats ───────────────────────────────────
        initialStock: initial,           // المخزون الأصلي عند الإضافة
        stock: product.stock,            // المخزون الحالي
        totalSold: sold,                 // إجمالي المبيع منذ الإضافة
        soldPercent,                     // نسبة المبيع %
        averageRating: product.averageRating ?? 0,
        ratingCount: product.ratingCount ?? 0,
        createdAt: product.createdAt,
    };
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * @desc   Admin store dashboard stats
 * @route  GET /api/store/admin/dashboard
 */
const adminDashboard = asyncHandler(async (req, res) => {
    const [
        totalProducts,
        activeProducts,
        soldOutProducts,
        totalOrders,
        pendingOrders,
        confirmedOrders,
        deliveredOrders,
        cancelledOrders,
        revenueResult,
        recentOrders,
    ] = await Promise.all([
        Product.countDocuments(),
        Product.countDocuments({ isActive: true, isSoldOut: false }),
        Product.countDocuments({ isSoldOut: true }),
        StoreOrder.countDocuments(),
        StoreOrder.countDocuments({ status: 'pending' }),
        StoreOrder.countDocuments({ status: 'confirmed' }),
        StoreOrder.countDocuments({ status: 'delivered' }),
        StoreOrder.countDocuments({ status: 'cancelled' }),
        StoreOrder.aggregate([
            { $match: { status: { $in: ['delivered', 'shipped'] } } },
            { $group: { _id: null, total: { $sum: '$totalPrice' } } },
        ]),
        StoreOrder.find()
            .sort({ createdAt: -1 })
            .limit(10)
            .select('storeOrderId userInfo totalPrice status createdAt'),
    ]);

    res.json({
        products: {
            total: totalProducts,
            active: activeProducts,
            soldOut: soldOutProducts,
        },
        orders: {
            total: totalOrders,
            pending: pendingOrders,
            confirmed: confirmedOrders,
            delivered: deliveredOrders,
            cancelled: cancelledOrders,
        },
        revenue: {
            totalDelivered: revenueResult[0]?.total || 0,
        },
        recentOrders,
    });
});

/**
 * @desc   Admin: Best-selling products with full inventory stats
 * @route  GET /api/store/admin/best-sellers
 * Query:  limit (default 20, max 100)
 *         agentId (optional — filter by agent)
 *         category (optional)
 */
const adminBestSellers = asyncHandler(async (req, res) => {
    const { limit = 20, agentId, category } = req.query;
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));

    const filter = {};
    if (agentId) filter.agentId = agentId;
    if (category) filter.category = { $regex: `^${category}$`, $options: 'i' };

    const products = await Product.find(filter)
        .sort({ totalSold: -1, averageRating: -1 })
        .limit(limitNum);

    res.json({
        total: products.length,
        products: products.map((p, i) => ({
            rank: i + 1,
            ...formatProductStats(p, req),
        })),
    });
});

/**
 * @desc   Admin/Agent: Inventory stats for a specific agent's products
 * @route  GET /api/store/admin/agent-stats/:agentId
 * Shows for each product: initialStock (when added), stock (now), totalSold, soldPercent
 */
const agentProductStats = asyncHandler(async (req, res) => {
    const { agentId } = req.params;
    const { isActive, isSoldOut, sortBy = 'totalSold' } = req.query;

    const filter = { agentId };
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (isSoldOut !== undefined) filter.isSoldOut = isSoldOut === 'true';

    const validSorts = { totalSold: -1, stock: 1, name: 1, createdAt: -1 };
    const sortField = validSorts[sortBy] !== undefined ? sortBy : 'totalSold';
    const sortOrder = validSorts[sortField];

    const products = await Product.find(filter).sort({ [sortField]: sortOrder });

    if (products.length === 0) {
        return res.json({
            agentId,
            summary: { totalProducts: 0, totalInitialStock: 0, totalCurrentStock: 0, totalSold: 0 },
            products: [],
        });
    }

    const formatted = products.map(p => formatProductStats(p, req));

    // Aggregate summary
    const summary = {
        totalProducts: formatted.length,
        activeProducts: formatted.filter(p => p.isActive).length,
        soldOutProducts: formatted.filter(p => p.isSoldOut).length,
        totalInitialStock: formatted.reduce((s, p) => s + p.initialStock, 0),
        totalCurrentStock: formatted.reduce((s, p) => s + p.stock, 0),
        totalSold: formatted.reduce((s, p) => s + p.totalSold, 0),
        overallSoldPercent: (() => {
            const totalInitial = formatted.reduce((s, p) => s + p.initialStock, 0);
            const totalSold = formatted.reduce((s, p) => s + p.totalSold, 0);
            return totalInitial > 0 ? Math.round((totalSold / totalInitial) * 100) : 0;
        })(),
    };

    res.json({ agentId, summary, products: formatted });
});

/**
 * @desc   Agent store dashboard – view own stock & sold-out info
 * @route  GET /api/store/agent/dashboard
 */
const agentDashboard = asyncHandler(async (req, res) => {
    const agentId = req.user.id;

    const [
        totalProducts,
        availableProducts,
        soldOutProducts,
        lowStockProducts,
        recentOrders,
        returnPendingCount,
        returnedCount,
    ] = await Promise.all([
        Product.countDocuments({ agentId, isActive: true }),
        Product.countDocuments({ agentId, isActive: true, isSoldOut: false }),
        Product.find({ agentId, isActive: true, isSoldOut: true })
            .select('name category stock initialStock totalSold isSoldOut updatedAt'),
        Product.find({ agentId, isActive: true, isSoldOut: false, stock: { $lte: 5 } })
            .sort({ stock: 1 })
            .select('name category stock initialStock totalSold'),
        StoreOrder.find({
            $or: [{ involvedAgents: agentId }, { agentId }],
            status: { $in: ['pending', 'confirmed', 'processing'] }
        })
            .sort({ createdAt: -1 })
            .limit(20)
            .select('storeOrderId userInfo totalPrice status createdAt'),
        StoreOrder.countDocuments({
            $or: [{ involvedAgents: agentId }, { agentId }],
            status: { $in: ['return_pending', 'return_accepted', 'return_delivering'] },
        }),
        StoreOrder.countDocuments({
            $or: [{ involvedAgents: agentId }, { agentId }],
            status: 'returned',
        }),
    ]);

    res.json({
        inventory: {
            total: totalProducts,
            available: availableProducts,
            soldOut: soldOutProducts.length,
        },
        soldOutProducts,
        lowStockProducts,
        activeOrders: recentOrders,
        returnPendingCount: returnPendingCount || 0,
        returnedCount: returnedCount || 0,
    });
});

module.exports = { adminDashboard, adminBestSellers, agentProductStats, agentDashboard };

