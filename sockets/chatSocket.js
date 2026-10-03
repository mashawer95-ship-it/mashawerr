/**
 * chatSocket.js
 * Socket.IO namespace: /chat
 *
 * Handles real-time messaging between Client and Representative.
 * Unread badge logic:
 *   - After every sendMessage  → push 'unreadCount' to receiver's personal room
 *   - After every markAsRead   → push updated 'unreadCount' back to the reader
 * FCM Push Notification:
 *   - On every sendMessage     → push notification sent to receiver via notifyClient
 */
const { socketAuthMiddleware } = require('../middlewares/socketAuth');
const Message = require('../models/Message');
const { notifyClient } = require('../services/notifyClient');
const { resolveOrderIds } = require('../utils/orderIdResolver');
const logger = require('../utils/logger');

// ── Helper: count unread messages for a user (optionally scoped to one order) ──
async function getUnreadCount(userId, orderId = null) {
    const query = { receiverId: userId, status: { $ne: 'read' } };
    if (orderId) {
        const { allIds } = await resolveOrderIds(orderId);
        query.orderId = { $in: allIds };
    }
    return Message.countDocuments(query);
}

// ── Helper: push unread counts to a user's personal socket room ──────────────
async function pushUnreadCount(nsp, userId, orderId) {
    const { allIds } = await resolveOrderIds(orderId);
    const [orderCount, totalCount] = await Promise.all([
        getUnreadCount(userId, orderId),
        getUnreadCount(userId),
    ]);

    // Push unread count under ALL identifiers so badges bound to either numeric or mongoId receive it
    for (const oid of allIds) {
        nsp.to(`user:${userId}`).emit('unreadCount', {
            orderId: oid,
            orderUnread: orderCount,   // Badge on THIS order's chat icon
            totalUnread: totalCount,    // Badge on the main chat/tab icon
        });
    }
}

function registerChatSocket(io) {
    const nsp = io.of('/chat');

    // Apply JWT auth
    nsp.use(socketAuthMiddleware);

    nsp.on('connection', (socket) => {
        const user = socket.user; // populated by socketAuthMiddleware
        
        // 1. Join personal room (to receive direct messages when not in a specific chat room)
        socket.join(`user:${user.id}`);
        
        // Broadcast to everyone that this user is online
        socket.broadcast.emit('userStatus', { userId: user.id, status: 'online' });
        logger.debug(`[Chat] User ${user.id} connected. Socket ID: ${socket.id}`);

        // 2. Join a specific order's chat room (joins rooms for ALL representations of the orderId)
        socket.on('joinChat', async ({ orderId }) => {
            if (!orderId) return;
            const { allIds } = await resolveOrderIds(orderId);
            for (const oid of allIds) {
                socket.join(`chat:${oid}`);
            }
            logger.debug(`[Chat] User ${user.id} joined chat rooms: ${allIds.join(', ')}`);
        });

        // 3. Leave a specific order's chat room
        socket.on('leaveChat', async ({ orderId }) => {
            if (!orderId) return;
            const { allIds } = await resolveOrderIds(orderId);
            for (const oid of allIds) {
                socket.leave(`chat:${oid}`);
            }
            logger.debug(`[Chat] User ${user.id} left chat rooms: ${allIds.join(', ')}`);
        });

        // 4. Typing indicator
        socket.on('typing', async ({ orderId, isTyping }) => {
            if (!orderId) return;
            const { allIds } = await resolveOrderIds(orderId);
            for (const oid of allIds) {
                socket.to(`chat:${oid}`).emit('userTyping', {
                    orderId: oid,
                    allOrderIds: allIds,
                    userId: user.id,
                    isTyping
                });
            }
        });

        // 5. Send a new message (supports text, image, voice)
        socket.on('sendMessage', async (payload, callback) => {
            try {
                const { 
                    orderId, 
                    receiverId, 
                    text, 
                    imageUrl, 
                    audioUrl, 
                    audioDuration, 
                    messageType,
                    senderName: clientProvidedSenderName
                } = payload;

                if (!orderId || !receiverId) {
                    if (typeof callback === 'function') callback({ success: false, error: 'orderId and receiverId are required' });
                    return;
                }

                if (!text && !imageUrl && !audioUrl) {
                    if (typeof callback === 'function') callback({ success: false, error: 'text, imageUrl, or audioUrl is required' });
                    return;
                }

                const resolvedType = audioUrl ? 'voice' : (imageUrl ? 'image' : (messageType || 'text'));

                const userFullName = user.name || (user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : '');
                const effectiveSenderName = clientProvidedSenderName || userFullName || '';

                const { allIds, numericId, mongoId, canonicalId } = await resolveOrderIds(orderId);
                const primaryOrderId = canonicalId || String(orderId);

                // Save to MongoDB with canonical orderId
                const message = new Message({
                    orderId: primaryOrderId,
                    senderId: user.id,
                    receiverId,
                    text: text || '',
                    imageUrl: imageUrl || null,
                    audioUrl: audioUrl || null,
                    audioDuration: Number(audioDuration) || 0,
                    messageType: resolvedType,
                    senderName: effectiveSenderName,
                    status: 'sent'
                });

                await message.save();
                const msgData = message.toObject();

                // Attach alternative order identifiers so any client matching rule succeeds
                msgData.allOrderIds = allIds;
                if (mongoId) msgData.orderMongoId = mongoId;
                if (numericId) msgData.orderNumericId = numericId;

                // Broadcast to ALL order room aliases (e.g. chat:45 and chat:66f28...)
                for (const oid of allIds) {
                    nsp.to(`chat:${oid}`).emit('receiveMessage', msgData);
                }

                // Also broadcast to the receiver's personal room
                socket.to(`user:${receiverId}`).emit('receiveMessage', msgData);

                // ── Push updated unread count to the RECEIVER immediately (for all orderId aliases) ────
                await pushUnreadCount(nsp, receiverId, orderId);

                // ── Send Push Notification (FCM) to the RECEIVER ─────────────
                try {
                    let notificationBody = text || '';
                    if (!notificationBody) {
                        if (resolvedType === 'voice') notificationBody = '🎤 تسجيل صوتي';
                        else if (resolvedType === 'image') notificationBody = '📷 صورة';
                        else notificationBody = 'رسالة جديدة';
                    }

                    const notificationTitle = effectiveSenderName || 'رسالة جديدة';

                    notifyClient(
                        receiverId,
                        notificationTitle,
                        notificationBody,
                        {
                            type: 'CHAT_MESSAGE',
                            orderId: primaryOrderId,
                            rawOrderId: String(orderId),
                            orderMongoId: mongoId || '',
                            orderNumericId: numericId || '',
                            senderId: String(user.id),
                            messageId: String(message._id),
                            messageType: resolvedType
                        }
                    ).catch(fcmErr => {
                        logger.warn(`[Chat] FCM push error for user ${receiverId}: ${fcmErr.message}`);
                    });
                } catch (pushErr) {
                    logger.warn(`[Chat] Error dispatching push notification: ${pushErr.message}`);
                }

                if (typeof callback === 'function') callback({ success: true, message: msgData });
            } catch (error) {
                logger.error(`[Chat] sendMessage error: ${error.message}`);
                if (typeof callback === 'function') callback({ success: false, error: 'Internal server error' });
            }
        });

        // 6. Mark messages as read
        socket.on('markAsRead', async ({ orderId, messageIds }, callback) => {
            try {
                if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
                    if (typeof callback === 'function') callback({ success: false, error: 'messageIds array is required' });
                    return;
                }

                // Update in MongoDB
                await Message.updateMany(
                    { _id: { $in: messageIds }, receiverId: user.id },
                    { $set: { status: 'read', readAt: new Date() } }
                );

                const now = new Date();
                const { allIds } = await resolveOrderIds(orderId);

                // Notify others in ALL chat room aliases for this order
                for (const oid of allIds) {
                    nsp.to(`chat:${oid}`).emit('messagesRead', {
                        orderId: oid,
                        allOrderIds: allIds,
                        messageIds,
                        readBy: user.id,
                        readAt: now
                    });
                }

                // ── Push updated (now lower) unread count back to READER ─────
                await pushUnreadCount(nsp, user.id, orderId);

                if (typeof callback === 'function') callback({ success: true });
            } catch (error) {
                logger.error(`[Chat] markAsRead error: ${error.message}`);
                if (typeof callback === 'function') callback({ success: false, error: 'Internal server error' });
            }
        });

        // 7. Disconnect
        socket.on('disconnect', () => {
            socket.broadcast.emit('userStatus', { 
                userId: user.id, 
                status: 'offline', 
                lastSeen: new Date() 
            });
            logger.debug(`[Chat] User ${user.id} disconnected`);
        });
    });
    
    logger.info('[Chat] /chat namespace registered with multimedia & FCM push support');
}

module.exports = { registerChatSocket };
