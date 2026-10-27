const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Message = require('../models/Message');
const { Order } = require('../middlewares/Order');
const { User } = require('../middlewares/User');
const { sanitizeErrorResponse } = require('../middlewares/objectAuthorization');
const { resolveOrderIds } = require('../utils/orderIdResolver');

/**
 * GET /api/chat/:orderId
 * Fetch chat history for a specific order.
 * Query params:
 * - limit: number of messages to return (default 50 for regular users, 500 for admin)
 * - before: timestamp to paginate (fetch messages older than this)
 */
const getChatHistory = asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { limit, before } = req.query;

    const { allIds, numericId, mongoId } = await resolveOrderIds(orderId);

    const userTypeLower = (req.user?.userType || req.fullUser?.userType || '').toString().toLowerCase();
    const isAdmin = req.user?.isAdmin === true ||
        req.fullUser?.isAdmin === true ||
        userTypeLower === 'admin' ||
        userTypeLower === 'administration';

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

    let normalOrder = null;
    try {
        if (orderConditions.length > 0) {
            normalOrder = await Order.findOne({ $or: orderConditions }).select('orderId clientId representativeId status orderCategory createdAt').lean();
        }
    } catch (_) {}

    if (!isAdmin) {
        if (process.env.TEST_MODE === 'true' && mongoose.connection.readyState !== 1) {
            return sanitizeErrorResponse(res, true, true);
        }
        const userIdStr = req.user?.id?.toString();

        const isParticipant = await Message.exists({ orderId: { $in: allIds }, $or: [{ senderId: userIdStr }, { receiverId: userIdStr }] });
        const isOrderOwner = Boolean(normalOrder && (normalOrder.clientId?.toString() === userIdStr || normalOrder.representativeId?.toString() === userIdStr));

        if (!isParticipant && !isOrderOwner) {
            return sanitizeErrorResponse(res, true, true);
        }
    }

    // Resolve participant profiles (client & representative)
    let clientInfo = null;
    let repInfo = null;
    try {
        if (normalOrder && User) {
            const userPromises = [];
            if (normalOrder.clientId && mongoose.isValidObjectId(normalOrder.clientId)) {
                userPromises.push(User.findById(normalOrder.clientId).select('firstName lastName phone profileImage').lean().catch(() => null));
            } else {
                userPromises.push(Promise.resolve(null));
            }

            if (normalOrder.representativeId && mongoose.isValidObjectId(normalOrder.representativeId)) {
                userPromises.push(User.findById(normalOrder.representativeId).select('firstName lastName phone profileImage').lean().catch(() => null));
            } else {
                userPromises.push(Promise.resolve(null));
            }

            const [clientDoc, repDoc] = await Promise.all(userPromises);
            if (clientDoc) {
                clientInfo = {
                    id: normalOrder.clientId,
                    name: `${clientDoc.firstName || ''} ${clientDoc.lastName || ''}`.trim() || 'العميل',
                    phone: clientDoc.phone || '',
                    photo: clientDoc.profileImage || null,
                };
            }
            if (repDoc) {
                repInfo = {
                    id: normalOrder.representativeId,
                    name: `${repDoc.firstName || ''} ${repDoc.lastName || ''}`.trim() || 'المندوب',
                    phone: repDoc.phone || '',
                    photo: repDoc.profileImage || null,
                };
            }
        }
    } catch (_) {}

    const maxLimit = isAdmin ? (Number(limit) || 500) : (Number(limit) || 50);
    let query = { orderId: { $in: allIds } };
    if (before) {
        query.createdAt = { $lt: new Date(before) };
    }

    const messages = await Message.find(query)
        .sort({ createdAt: -1 })
        .limit(maxLimit);

    const enrichedMessages = messages.map(m => {
        const doc = m.toObject ? m.toObject() : m;
        const senderStr = doc.senderId?.toString();
        let role = 'unknown';
        if (normalOrder) {
            if (normalOrder.clientId && senderStr === normalOrder.clientId.toString()) {
                role = 'client';
            } else if (normalOrder.representativeId && senderStr === normalOrder.representativeId.toString()) {
                role = 'representative';
            }
        }
        return {
            ...doc,
            senderRole: role,
        };
    });

    res.json({
        success: true,
        data: enrichedMessages.reverse(), // Return in chronological order
        orderInfo: {
            orderId: normalOrder?.orderId || numericId || mongoId || orderId,
            status: normalOrder?.status || null,
            orderCategory: normalOrder?.orderCategory || null,
            client: clientInfo,
            representative: repInfo,
        }
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
