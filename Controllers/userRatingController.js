const asyncHandler = require('express-async-handler');
const { UserRating, RatingSkip, validateUserRating } = require('../middlewares/UserRating');
const { Order } = require('../middlewares/Order');
const { User } = require('../middlewares/User');
const { redisGet, redisSet, redisDel } = require('../config/redis');

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
    // 1. Support legacy field names in request body
    if (!req.body.raterId && req.body.ratedById) {
        req.body.raterId = req.body.ratedById;
    }
    if (!req.body.rateeId && req.body.ratedUserId) {
        req.body.rateeId = req.body.ratedUserId;
    }
    if (req.body.rating == null && req.body.stars != null) {
        req.body.rating = req.body.stars;
    }

    // Auto-assign raterId from token if missing from request body
    if (!req.body.raterId && req.user?.id) {
        req.body.raterId = req.user.id.toString();
    }

    const raterIdStr = (req.body.raterId || req.user?.id || '').toString().trim();
    const rateeIdStr = (req.body.rateeId || '').toString().trim();

    // 2. Auto-detect raterType and rateeType if missing
    if (!req.body.raterType || !req.body.rateeType) {
        let raterType = req.body.raterType;
        let rateeType = req.body.rateeType;

        const tokenUserType = (req.user?.userType || '').toLowerCase();
        if (['representative', 'rep', 'driver', 'captain'].includes(tokenUserType)) {
            raterType = 'representative';
            rateeType = 'client';
        } else if (['client', 'customer', 'user'].includes(tokenUserType)) {
            raterType = 'client';
            rateeType = 'representative';
        } else {
            const mongoose = require('mongoose');
            if (mongoose.Types.ObjectId.isValid(raterIdStr)) {
                const raterUser = await User.findById(raterIdStr).select('userType').lean();
                const rUserType = (raterUser?.userType || '').toLowerCase();
                if (['representative', 'rep', 'driver', 'captain'].includes(rUserType)) {
                    raterType = 'representative';
                    rateeType = 'client';
                } else {
                    raterType = 'client';
                    rateeType = 'representative';
                }
            }
        }
        req.body.raterType = raterType || 'representative';
        req.body.rateeType = rateeType || (req.body.raterType === 'client' ? 'representative' : 'client');
    }

    let orderIdParam = (req.params.orderId || req.body.orderId || '').toString().trim();

    // 3. If orderId is missing, attempt to find latest completed order between rater and ratee
    if (!orderIdParam && raterIdStr && rateeIdStr) {
        const COMPLETED_STATUSES = ['completed', 'delivered', 'تم التسليم', 'مكتمل', '3', 'ended', 'done'];
        const recentOrder = await Order.findOne({
            $or: [
                { clientId: raterIdStr, representativeId: rateeIdStr },
                { clientId: rateeIdStr, representativeId: raterIdStr },
                { userId: raterIdStr, representativeId: rateeIdStr },
                { userId: rateeIdStr, representativeId: raterIdStr },
            ],
            status: { $in: COMPLETED_STATUSES },
        }).sort({ updatedAt: -1, createdAt: -1 }).lean();

        if (recentOrder) {
            orderIdParam = (recentOrder.orderId || recentOrder._id).toString();
        }
    }

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
        filterConditions.push({ orderId: orderIdParam });
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

    const finalRaterId = value.raterId.toString();
    const finalRateeId = value.rateeId.toString();

    // ── التحقق من أن المقيِّم والمقيَّم مختلفان ────────────────────────────
    if (finalRaterId === finalRateeId) {
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

        const isClientRater  = value.raterType === 'client' && (orderClientId === finalRaterId || !orderClientId);
        const isRepRater     = value.raterType === 'representative' && (orderRepId === finalRaterId || !orderRepId);

        if (!isClientRater && !isRepRater && !isAdmin) {
            return res.status(403).json({
                message: 'You are not a participant in this order',
            });
        }

        const isClientRatee  = value.rateeType === 'client' && (orderClientId === finalRateeId || !orderClientId);
        const isRepRatee     = value.rateeType === 'representative' && (orderRepId === finalRateeId || !orderRepId);

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
        raterId: finalRaterId,
        rateeId: finalRateeId,
    });

    await UserRating.findOneAndUpdate(
        { orderId: normalizedOrderId, raterId: finalRaterId, rateeId: finalRateeId },
        {
            raterType: value.raterType,
            rateeType: value.rateeType,
            rating:    value.rating,
            comment:   value.comment,
            reasons:   value.reasons || [],
        },
        { upsert: true, new: true }
    );

    // تنظيف أي تخطي مسجل مسبقاً لهذا الأوردر إن وجد
    RatingSkip.deleteOne({ userId: finalRaterId, orderId: normalizedOrderId }).catch(() => {});
    redisDel(`rating_skip:${finalRaterId}:${normalizedOrderId}`).catch(() => {});

    const stats = await calcUserStats(finalRateeId);

    return res.status(alreadyExists ? 200 : 201).json({
        message: alreadyExists ? 'Rating updated successfully' : 'Rating submitted successfully',
        orderId:       normalizedOrderId,
        raterId:       finalRaterId,
        raterType:     value.raterType,
        rateeId:       finalRateeId,
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

/**
 * @desc   Get pending unrated completed order for the authenticated user (cloud persistent recovery)
 * @route  GET /api/ratings/pending
 * @access Private (verifyToken)
 */
const getPendingRating = asyncHandler(async (req, res) => {
    const userId = req.user?.id?.toString();
    if (!userId) {
        return res.status(401).json({ message: 'Authentication required' });
    }

    const rawUserType = (req.user?.userType || req.fullUser?.userType || '').toLowerCase();
    const isRep = ['representative', 'driver', 'rep', 'captain', 'delegate'].includes(rawUserType);

    const COMPLETED_STATUSES = ['completed', 'delivered', 'تم التسليم', 'مكتمل', '3', 'ended', 'done'];

    let order = null;
    if (isRep) {
        order = await Order.findOne({
            representativeId: userId,
            status: { $in: COMPLETED_STATUSES },
            $or: [
                { clientId: { $exists: true, $ne: null } },
                { userId: { $exists: true, $ne: null } },
            ],
        })
        .sort({ updatedAt: -1, createdAt: -1 })
        .select('orderId clientId userId status createdAt updatedAt')
        .lean();
    } else {
        order = await Order.findOne({
            $or: [
                { clientId: userId },
                { userId: userId },
            ],
            status: { $in: COMPLETED_STATUSES },
            representativeId: { $exists: true, $ne: null },
        })
        .sort({ updatedAt: -1, createdAt: -1 })
        .select('orderId representativeId status createdAt updatedAt')
        .lean();
    }

    if (!order) {
        return res.status(200).json({ hasPending: false });
    }

    const normalizedOrderId = order.orderId || order._id.toString();

    // 1. فحص هل قام المستخدم بتقييم هذا الأوردر مسبقاً
    const alreadyRated = await UserRating.exists({
        orderId: normalizedOrderId,
        raterId: userId,
    });
    if (alreadyRated) {
        return res.status(200).json({ hasPending: false });
    }

    // 2. فحص هل قام المستخدم بالضغط على تخطي لهذا الأوردر
    const redisSkip = await redisGet(`rating_skip:${userId}:${normalizedOrderId}`).catch(() => null);
    if (redisSkip) {
        return res.status(200).json({ hasPending: false });
    }

    const dbSkip = await RatingSkip.exists({
        userId,
        orderId: normalizedOrderId,
    });
    if (dbSkip) {
        await redisSet(`rating_skip:${userId}:${normalizedOrderId}`, '1', 86400 * 30).catch(() => {});
        return res.status(200).json({ hasPending: false });
    }

    // 3. جلب بيانات الطرف الآخر المراد تقييمه
    let rateeId = '';
    let userTypeStr = 'customer';

    if (isRep) {
        rateeId = (order.clientId || order.userId || '').toString();
        userTypeStr = 'representative';
    } else {
        rateeId = (order.representativeId || '').toString();
        userTypeStr = 'customer';
    }

    if (!rateeId) {
        return res.status(200).json({ hasPending: false });
    }

    const rateeUser = await User.findById(rateeId)
        .select('firstName lastName profileImage rating ratingCount')
        .lean();

    const rateeName = rateeUser
        ? `${rateeUser.firstName || ''} ${rateeUser.lastName || ''}`.trim()
        : (isRep ? 'العميل' : 'المندوب');

    return res.status(200).json({
        hasPending: true,
        data: {
            orderId: normalizedOrderId,
            ratedById: userId,
            ratedUserId: rateeId,
            ratedUserName: rateeName || (isRep ? 'العميل' : 'المندوب'),
            rateeImageUrl: rateeUser?.profileImage || null,
            rateeRating: rateeUser?.rating || 5.0,
            rateeRatingCount: rateeUser?.ratingCount || 0,
            userType: userTypeStr,
        },
    });
});

/**
 * @desc   Mark a rating as skipped for an order
 * @route  POST /api/ratings/order/:orderId/skip
 * @access Private (verifyToken)
 */
const skipOrderRating = asyncHandler(async (req, res) => {
    const rawOrderId = req.params.orderId;
    const userId = req.user?.id?.toString();

    if (!userId || !rawOrderId) {
        return res.status(400).json({ message: 'orderId and authentication required' });
    }

    const orderIdNum = parseInt(rawOrderId, 10);
    const normalizedOrderId = (!isNaN(orderIdNum) && orderIdNum > 0) ? orderIdNum : rawOrderId;

    await RatingSkip.findOneAndUpdate(
        { userId, orderId: normalizedOrderId },
        { userId, orderId: normalizedOrderId, skippedAt: new Date() },
        { upsert: true, new: true }
    );

    await redisSet(`rating_skip:${userId}:${normalizedOrderId}`, '1', 86400 * 30).catch(() => {});

    return res.status(200).json({
        success: true,
        message: 'Rating skipped successfully',
        orderId: normalizedOrderId,
    });
});

module.exports = {
    submitUserRating,
    getUserRatings,
    getOrderRatings,
    getPendingRating,
    skipOrderRating,
};
