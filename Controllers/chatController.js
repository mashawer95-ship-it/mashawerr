const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Message = require('../models/Message');
const { Order } = require('../middlewares/Order');
const { sanitizeErrorResponse } = require('../middlewares/objectAuthorization');
const { resolveOrderIds } = require('../utils/orderIdResolver');

/**
 * GET /api/chat/:orderId
 * Fetch chat history for a specific order.
 * Query params:
 * - limit: number of messages to return (default 50)
 * - before: timestamp to paginate (fetch messages older than this)
 */
const getChatHistory = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { limit = 50, before } = req.query;

    const { allIds, numericId, mongoId } = await resolveOrderIds(orderId);

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (!isAdmin) {
        if (process.env.TEST_MODE === 'true' && mongoose.connection.readyState !== 1) {
            return sanitizeErrorResponse(res, true, true);
        }
        const userIdStr = req.user?.id?.toString();

        const orderConditions = [];
        if (numericId && !isNaN(Number(numericId))) {
            orderConditions.push({ orderId: Number(numericId) });
        }
        if (mongoId && mongoose.isValidObjectId(mongoId)) {
            orderConditions.push({ _id: mongoId });
        }
        for (const id of allIds) {
            if (!isNaN(Number(id))) orderConditions.push({ orderId: Number(id) });
            if (mongoose.isValidObjectId(id)) orderConditions.push({ _id: id });
        }

        const [isParticipant, normalOrder] = await Promise.all([
            Message.exists({ orderId: { $in: allIds }, $or: [{ senderId: userIdStr }, { receiverId: userIdStr }] }),
            orderConditions.length > 0
                ? Order.findOne({ $or: orderConditions }).select('clientId representativeId').lean()
                : null
        ]);

        const isOrderOwner = Boolean(normalOrder && (normalOrder.clientId?.toString() === userIdStr || normalOrder.representativeId?.toString() === userIdStr));

        if (!isParticipant && !isOrderOwner) {
            return sanitizeErrorResponse(res, true, true);
        }
    }

    let query = { orderId: { $in: allIds } };
    if (before) {
        query.createdAt = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
        .sort({ createdAt: -1 })
        .limit(Number(limit));

    res.json({
        success: true,
        data: messages.reverse() // Return in chronological order
    });
});

/**
 * GET /api/chat/:orderId/unread
 * Returns the number of unread messages for the authenticated user in ONE order.
 * Used for the badge on a specific order's chat button.
 */
const getUnreadForOrder = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const userId = req.user.id;
    const { allIds } = await resolveOrderIds(orderId);

    const count = await Message.countDocuments({
        orderId: { $in: allIds },
        receiverId: userId,
        status: { $ne: 'read' },
    });

    res.json({ success: true, data: { orderId, unreadCount: count } });
});

/**
 * GET /api/chat/unread
 * Returns total unread count across ALL orders for the authenticated user.
 * Used for the main chat tab/icon badge.
 * Optional query: ?orderId=xxx to scope to a single order (same as /:orderId/unread)
 */
const getTotalUnread = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { orderId } = req.query;

    let query = { receiverId: userId, status: { $ne: 'read' } };
    if (orderId) {
        const { allIds } = await resolveOrderIds(orderId);
        query.orderId = { $in: allIds };
    }

    // Aggregate: total count + per-order breakdown
    const [totalCount, perOrder] = await Promise.all([
        Message.countDocuments(query),
        Message.aggregate([
            { $match: query },
            { $group: { _id: '$orderId', count: { $sum: 1 } } },
            { $project: { orderId: '$_id', count: 1, _id: 0 } },
        ]),
    ]);

    // Expand per-order breakdown so both numeric and MongoDB IDs are available to clients
    const expandedByOrder = [];
    const seenOrderKeys = new Set();

    for (const item of perOrder) {
        if (!seenOrderKeys.has(item.orderId)) {
            expandedByOrder.push(item);
            seenOrderKeys.add(item.orderId);
        }
        try {
            const { allIds } = await resolveOrderIds(item.orderId);
            for (const altId of allIds) {
                if (!seenOrderKeys.has(altId)) {
                    expandedByOrder.push({ orderId: altId, count: item.count });
                    seenOrderKeys.add(altId);
                }
            }
        } catch (_) {}
    }

    res.json({
        success: true,
        data: {
            totalUnread: totalCount,
            byOrder: expandedByOrder, // [{ orderId, count }, ...]
        },
    });
});

/**
 * POST /api/chat/upload
 * Upload image or voice recording attachment for chat.
 */
const uploadChatAttachment = asyncHandler(async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const fileUrl = req.file.path || req.file.secure_url || req.file.url;
    const mimetype = req.file.mimetype || '';
    const isAudio = mimetype.startsWith('audio') || /\.(m4a|mp3|aac|wav|ogg|opus|amr)$/i.test(req.file.originalname || '');
    const fileType = isAudio ? 'voice' : 'image';

    res.json({
        success: true,
        data: {
            url: fileUrl,
            fileType,
            originalName: req.file.originalname,
            size: req.file.size
        }
    });
});

module.exports = {
    uploadChatAttachment,
    getChatHistory,
    getUnreadForOrder,
    getTotalUnread,
};
