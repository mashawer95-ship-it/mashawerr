const asyncHandler = require('express-async-handler');
const { UserRating, validateUserRating } = require('../middlewares/UserRating');
const { Order } = require('../middlewares/Order');
const { User } = require('../middlewares/User');

const { sanitizeErrorResponse } = require('../middlewares/objectAuthorization');

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Calculate average rating + count for a given rateeId.
 */
async function calcUserStats(rateeId) {
    const [stats] = await UserRating.aggregate([
        { $match: { rateeId } },
        {
            $group: {
                _id: null,
                avg: { $avg: '$rating' },
                count: { $sum: 1 },
            },
        },
    ]);
    return {
        averageRating: stats ? Math.round(stats.avg * 10) / 10 : 0,
        ratingCount: stats ? stats.count : 0,
    };
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * @desc   Submit a rating for a user (client→rep OR rep→client) after order completion
 * @route  POST /api/ratings/order/:orderId
 * @access Public
 *
 * Body: { raterId, raterType, rateeId, rateeType, rating, comment? }
 */
const submitUserRating = asyncHandler(async (req, res) => {
    const orderIdParam = (req.params.orderId || '').trim();
    if (!orderIdParam) {
        return res.status(400).json({ message: 'orderId parameter is required' });
    }

    const orderIdNum = parseInt(orderIdParam, 10);
    const filterConditions = [];
    if (!isNaN(orderIdNum) && orderIdNum > 0) {
        filterConditions.push({ orderId: orderIdNum });
    }
    const mongoose = require('mongoose');
    if (mongoose.Types.ObjectId.isValid(orderIdParam)) {
        filterConditions.push({ _id: new mongoose.Types.ObjectId(orderIdParam) });
    }

    if (filterConditions.length === 0) {
        return res.status(400).json({ message: 'Invalid orderId parameter' });
    }

    // Auto-assign raterId from token if missing from request body
    if (!req.body.raterId && req.user?.id) {
        req.body.raterId = req.user.id.toString();
    }

    const { error, value } = validateUserRating(req.body);
    if (error) {
        return res.status(400).json({
            message: error.details.map((d) => d.message).join('; '),
        });
    }

    // Force identity to req.user.id to prevent raterId spoofing
    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (!isAdmin || !value.raterId) {
        value.raterId = req.user?.id?.toString() || value.raterId;
    }

    if (!value.raterId) {
        return res.status(400).json({ message: 'raterId is required' });
    }

    const raterIdStr = value.raterId.toString();
    const rateeIdStr = value.rateeId.toString();

    // ── التحقق من أن المقيِّم والمقيَّم مختلفان ────────────────────────────
    if (raterIdStr === rateeIdStr) {
        return res.status(400).json({ message: 'You cannot rate yourself' });
    }

    // ── التحقق من أن الرايتر والرايتي من نوعين مختلفين ──────────────────────
    if (value.raterType === value.rateeType) {
        return res.status(400).json({
            message: 'raterType and rateeType must be different (client ↔ representative)',
        });
    }

    // ── جلب الأوردر إن وجد ──────────────────────────────────────────────────
    const order = await Order.findOne({ $or: filterConditions }).lean();

    if (order) {
        // ── الأوردر موجود: التحقق من الحالة والمشاركين ──────────────────────────
        const COMPLETED_STATUSES = ['completed', 'delivered', 'تم التسليم', 'مكتمل', '3', 'ended', 'done'];
        const currentStatus = (order.status || '').toString().toLowerCase();
        if (!COMPLETED_STATUSES.includes(currentStatus)) {
            return res.status(403).json({
                message: 'Ratings can only be submitted for completed orders',
                currentStatus: order.status,
            });
        }

        const orderClientId = (order.clientId || order.userId || '').toString();
        const orderRepId = (order.representativeId || '').toString();

        const isClientRater  = value.raterType === 'client' && (orderClientId === raterIdStr || !orderClientId);
        const isRepRater     = value.raterType === 'representative' && (orderRepId === raterIdStr || !orderRepId);

        if (!isClientRater && !isRepRater && !isAdmin) {
            return res.status(403).json({
                message: 'You are not a participant in this order',
            });
        }

        const isClientRatee  = value.rateeType === 'client' && (orderClientId === rateeIdStr || !orderClientId);
        const isRepRatee     = value.rateeType === 'representative' && (orderRepId === rateeIdStr || !orderRepId);

        if (!isClientRatee && !isRepRatee) {
            return res.status(403).json({
                message: 'The ratee is not a participant in this order',
            });
        }
    }

    const normalizedOrderId = order
        ? (order.orderId || (!isNaN(orderIdNum) ? orderIdNum : orderIdParam))
        : (!isNaN(orderIdNum) ? orderIdNum : orderIdParam);

    // ── Upsert: تقييم واحد لكل رايتر/رايتي/أوردر ─────────────────────────
    const alreadyExists = await UserRating.exists({
        orderId: normalizedOrderId,
        raterId: raterIdStr,
        rateeId: rateeIdStr,
    });

    await UserRating.findOneAndUpdate(
        { orderId: normalizedOrderId, raterId: raterIdStr, rateeId: rateeIdStr },
        {
            raterType: value.raterType,
            rateeType: value.rateeType,
            rating:    value.rating,
            comment:   value.comment,
            reasons:   value.reasons || [],
        },
        { upsert: true, new: true }
    );

    const stats = await calcUserStats(rateeIdStr);

    return res.status(alreadyExists ? 200 : 201).json({
        message: alreadyExists ? 'Rating updated successfully' : 'Rating submitted successfully',
        orderId:       normalizedOrderId,
        raterId:       raterIdStr,
        raterType:     value.raterType,
        rateeId:       rateeIdStr,
        rateeType:     value.rateeType,
        yourRating:    value.rating,
        yourComment:   value.comment,
        yourReasons:   value.reasons || [],
        rateeStats:    stats,
    });
});

/**
 * @desc   Get all ratings received by a user + average stats
 * @route  GET /api/ratings/user/:userId
 * @access Public
 *
 * Query params: page (default 1), limit (default 20)
 */
const getUserRatings = asyncHandler(async (req, res) => {
    const userId = (req.params.userId || '').trim();
    if (!userId) {
        return res.status(400).json({ message: 'userId is required' });
    }

    const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip  = (page - 1) * limit;

    // ── التحقق من وجود المستخدم ──────────────────────────────────────────────
    const mongoose = require('mongoose');
    let user = null;
    if (mongoose.Types.ObjectId.isValid(userId)) {
        user = await User.findById(userId)
            .select('firstName lastName userType profileImage')
            .lean();
    }

    const [ratings, total, stats, completedOrdersCount] = await Promise.all([
        UserRating.find({ rateeId: userId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        UserRating.countDocuments({ rateeId: userId }),
        calcUserStats(userId),
        Order.countDocuments({ 
            $or: [{ clientId: userId }, { representativeId: userId }],
            status: { $in: ['completed', 'delivered'] }
        }),
    ]);

    // توزيع النجوم 5★ → 1★
    const distribution = await UserRating.aggregate([
        { $match: { rateeId: userId } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
        { $sort: { _id: -1 } },
    ]);

    return res.status(200).json({
        userId,
        userName: user
            ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
            : null,
        userType: user?.userType || null,
        averageRating: stats.averageRating,
        ratingCount:   stats.ratingCount,
        completedOrdersCount, // عدد الأوردرات المكتملة الفعلي
        distribution:  distribution.map((d) => ({ stars: d._id, count: d.count })),
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        ratings,
    });
});

/**
 * @desc   Get all ratings for a specific order (both directions)
 * @route  GET /api/ratings/order/:orderId
 * @access Public
 */
const getOrderRatings = asyncHandler(async (req, res) => {
    const orderIdParam = (req.params.orderId || '').trim();
    if (!orderIdParam) {
        return res.status(400).json({ message: 'orderId parameter is required' });
    }

    const orderIdNum = parseInt(orderIdParam, 10);
    const filterConditions = [];
    if (!isNaN(orderIdNum) && orderIdNum > 0) {
        filterConditions.push({ orderId: orderIdNum });
    }
    const mongoose = require('mongoose');
    if (mongoose.Types.ObjectId.isValid(orderIdParam)) {
        filterConditions.push({ _id: new mongoose.Types.ObjectId(orderIdParam) });
    }

    if (filterConditions.length === 0) {
        return res.status(400).json({ message: 'Invalid orderId parameter' });
    }

    const order = await Order.findOne({ $or: filterConditions })
        .select('orderId clientId userId representativeId status')
        .lean();

    if (!order) {
        return sanitizeErrorResponse(res, false, true);
    }

    const orderClientId = (order.clientId || order.userId || '').toString();
    const orderRepId = (order.representativeId || '').toString();
    const reqUserId = req.user?.id?.toString() || '';

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isOwner = (orderClientId && orderClientId === reqUserId)
        || (orderRepId && orderRepId === reqUserId);

    if (!isOwner && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const normalizedOrderId = order.orderId || (!isNaN(orderIdNum) ? orderIdNum : 0);
    const ratings = await UserRating.find({ orderId: normalizedOrderId }).lean();

    // عزل التقييمات: العميل → المندوب و المندوب → العميل
    const clientToRep = ratings.find(
        (r) => r.raterType === 'client' && r.rateeType === 'representative'
    ) || null;

    const repToClient = ratings.find(
        (r) => r.raterType === 'representative' && r.rateeType === 'client'
    ) || null;

    return res.status(200).json({
        orderId:          normalizedOrderId,
        clientId:         orderClientId || null,
        representativeId: orderRepId || null,
        orderStatus:      order.status,
        clientRatedRep:   clientToRep  ? { rating: clientToRep.rating,  comment: clientToRep.comment,  reasons: clientToRep.reasons || [], createdAt: clientToRep.createdAt  } : null,
        repRatedClient:   repToClient  ? { rating: repToClient.rating,   comment: repToClient.comment,  reasons: repToClient.reasons || [], createdAt: repToClient.createdAt  } : null,
        ratings,
    });
});

module.exports = { submitUserRating, getUserRatings, getOrderRatings };
