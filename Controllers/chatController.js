const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Message = require('../models/Message');
const { Order } = require('../middlewares/Order');
const { StoreOrder } = require('../middlewares/StoreOrder');
const { sanitizeErrorResponse } = require('../middlewares/objectAuthorization');

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

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (!isAdmin) {
        if (process.env.TEST_MODE === 'true' && mongoose.connection.readyState !== 1) {
            return sanitizeErrorResponse(res, true, true);
        }
        const userIdStr = req.user?.id?.toString();
        const isValidObjectId = mongoose.Types.ObjectId.isValid(orderId) && /^[0-9a-fA-F]{24}$/.test(orderId);
        const numericOrderId = Number(orderId);
        const isNumeric = !isNaN(numericOrderId);

        const orderConditions = [];
        if (isNumeric) {
            orderConditions.push({ orderId: numericOrderId });
        }
        if (isValidObjectId) {
            orderConditions.push({ _id: orderId });
        }

        const storeOrderConditions = [];
        if (isNumeric) {
            storeOrderConditions.push({ storeOrderId: numericOrderId });
            storeOrderConditions.push({ orderId: numericOrderId });
        }
        if (isValidObjectId) {
            storeOrderConditions.push({ _id: orderId });
        }

        const [isParticipant, normalOrder, storeOrder] = await Promise.all([
            Message.exists({ orderId: String(orderId), $or: [{ senderId: userIdStr }, { receiverId: userIdStr }] }),
            orderConditions.length > 0
                ? Order.findOne({ $or: orderConditions }).select('clientId representativeId').lean()
                : null,
            storeOrderConditions.length > 0
                ? StoreOrder.findOne({ $or: storeOrderConditions }).select('userId representativeId agentId involvedAgents').lean()
                : null
        ]);

        const isOrderOwner = (normalOrder && (normalOrder.clientId?.toString() === userIdStr || normalOrder.representativeId?.toString() === userIdStr))
            || (storeOrder && (storeOrder.userId?.toString() === userIdStr || storeOrder.representativeId?.toString() === userIdStr || storeOrder.agentId?.toString() === userIdStr));

        if (!isParticipant && !isOrderOwner) {
            return sanitizeErrorResponse(res, true, true);
        }
    }

    let query = { orderId };
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

    const count = await Message.countDocuments({
        orderId,
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

    const query = { receiverId: userId, status: { $ne: 'read' } };
    if (orderId) query.orderId = orderId;

    // Aggregate: total count + per-order breakdown
    const [totalCount, perOrder] = await Promise.all([
        Message.countDocuments(query),
        Message.aggregate([
            { $match: query },
            { $group: { _id: '$orderId', count: { $sum: 1 } } },
            { $project: { orderId: '$_id', count: 1, _id: 0 } },
        ]),
    ]);

    res.json({
        success: true,
        data: {
            totalUnread: totalCount,
            byOrder: perOrder, // [{ orderId, count }, ...]
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
