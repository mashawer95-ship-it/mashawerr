const path = require('path');
const { User } = require('../middlewares/User');
const { Product } = require('../middlewares/Product');
const { buildUrl } = require('../config/urlBuilder');

// ─── Helper ───────────────────────────────────────────────────────────────────

function buildImageUrl(req, filename) {
    if (!filename) return null;
    // Already a full URL — return as-is
    if (filename.startsWith('http://') || filename.startsWith('https://')) return filename;
    return buildUrl(req, `products/${path.basename(filename)}`);
}

function formatProduct(product, req) {
    const obj = product.toObject ? product.toObject() : { ...product };

    // Backward compatibility: old products stored a single image string in `image`
    let rawImages = [];
    if (Array.isArray(obj.images) && obj.images.length > 0) {
        rawImages = obj.images;
    } else if (obj.image && typeof obj.image === 'string' && obj.image.trim() !== '') {
        rawImages = [obj.image];
    }

    obj.images = rawImages
        .filter(f => f && f.trim() !== '')
        .map(f => buildImageUrl(req, f));

    delete obj.image; // remove legacy field
    return obj;
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * @desc   Get all agents (admin only)
 * @route  GET /api/store/agents
 */
const getAllAgents = async (req, res) => {
    const agents = await User.find({ userType: 'Agent' })
        .select('_id firstName lastName email phone profileImage createdAt')
        .sort({ firstName: 1 });

    const result = agents.map(a => {
        const obj = a.toObject();
        return {
            _id: obj._id,
            firstName: obj.firstName,
            lastName: obj.lastName,
            fullName: `${obj.firstName} ${obj.lastName}`,
            email: obj.email,
            phone: obj.phone,
            createdAt: obj.createdAt,
        };
    });

    res.json({ total: result.length, agents: result });
};

/**
 * @desc   Get all products belonging to a specific agent (admin only)
 * @route  GET /api/store/agents/:agentId/products
 */
const getAgentProducts = async (req, res) => {
    const { agentId } = req.params;
    const { page = 1, limit = 50, search, category, isSoldOut, isActive } = req.query;

    // Verify agent exists
    const agent = await User.findOne({ _id: agentId, userType: 'Agent' })
        .select('_id firstName lastName email phone');
    if (!agent) return res.status(404).json({ message: 'Agent not found' });

    const filter = { agentId };

    if (isActive !== undefined) filter.isActive = isActive === 'true';

    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
            { category: { $regex: search, $options: 'i' } },
        ];
    }

    if (category) filter.category = { $regex: `^${category}$`, $options: 'i' };
    if (isSoldOut !== undefined) filter.isSoldOut = isSoldOut === 'true';

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [products, total] = await Promise.all([
        Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
        Product.countDocuments(filter),
    ]);

    res.json({
        agent: {
            _id: agent._id,
            fullName: `${agent.firstName} ${agent.lastName}`,
            email: agent.email,
            phone: agent.phone,
        },
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        products: products.map(p => formatProduct(p, req)),
    });
};

/**
 * @desc   Get all agents with their product counts + products (admin dashboard overview)
 * @route  GET /api/store/agents/overview
 */
const getAgentsOverview = async (req, res) => {
    const agents = await User.find({ userType: 'Agent' })
        .select('_id firstName lastName email phone')
        .sort({ firstName: 1 });

    const agentIds = agents.map(a => a._id.toString());

    // Count products per agent
    const counts = await Product.aggregate([
        { $match: { agentId: { $in: agentIds } } },
        { $group: { _id: '$agentId', productCount: { $sum: 1 }, activeCount: { $sum: { $cond: ['$isActive', 1, 0] } } } },
    ]);

    const countMap = {};
    counts.forEach(c => { countMap[c._id] = c; });

    const result = agents.map(a => {
        const id = a._id.toString();
        return {
            _id: id,
            fullName: `${a.firstName} ${a.lastName}`,
            email: a.email,
            phone: a.phone,
            productCount: countMap[id]?.productCount ?? 0,
            activeProductCount: countMap[id]?.activeCount ?? 0,
        };
    });

    res.json({ total: result.length, agents: result });
};

module.exports = { getAllAgents, getAgentProducts, getAgentsOverview };
