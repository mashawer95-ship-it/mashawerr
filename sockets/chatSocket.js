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
const logger = require('../utils/logger');

// ── Helper: count unread messages for a user (optionally scoped to one order) ──
async function getUnreadCount(userId, orderId = null) {
    const query = { receiverId: userId, status: { $ne: 'read' } };
    if (orderId) query.orderId = String(orderId);
    return Message.countDocuments(query);
}

// ── Helper: push unread counts to a user's personal socket room ──────────────
async function pushUnreadCount(nsp, userId, orderId) {
    const [orderCount, totalCount] = await Promise.all([
        getUnreadCount(userId, orderId),
        getUnreadCount(userId),
    ]);
    nsp.to(`user:${userId}`).emit('unreadCount', {
        orderId,
        orderUnread: orderCount,   // Badge on THIS order's chat icon
        totalUnread: totalCount,    // Badge on the main chat/tab icon
    });
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

        // 2. Join a specific order's chat room
        socket.on('joinChat', ({ orderId }) => {
            if (!orderId) return;
            socket.join(`chat:${orderId}`);
            logger.debug(`[Chat] User ${user.id} joined chat room: ${orderId}`);
        });

        // 3. Leave a specific order's chat room
        socket.on('leaveChat', ({ orderId }) => {
            if (!orderId) return;
            socket.leave(`chat:${orderId}`);
            logger.debug(`[Chat] User ${user.id} left chat room: ${orderId}`);
        });

        // 4. Typing indicator
        socket.on('typing', ({ orderId, isTyping }) => {
            if (!orderId) return;
            socket.to(`chat:${orderId}`).emit('userTyping', {
                orderId,
                userId: user.id,
                isTyping
            });
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

                // Save to MongoDB
                const message = new Message({
                    orderId: String(orderId),
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

                // Broadcast to the order's chat room
                nsp.to(`chat:${orderId}`).emit('receiveMessage', msgData);

                // Also broadcast to the receiver's personal room
                socket.to(`user:${receiverId}`).emit('receiveMessage', msgData);

                // ── Push updated unread count to the RECEIVER immediately ────
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
                            orderId: String(orderId),
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

                // Notify others in the chat room that these messages were read
                nsp.to(`chat:${orderId}`).emit('messagesRead', {
                    orderId,
                    messageIds,
                    readBy: user.id,
                    readAt: now
                });

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
