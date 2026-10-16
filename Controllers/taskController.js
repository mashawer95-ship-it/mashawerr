const asyncHandler = require('express-async-handler');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Order } = require('../middlewares/Order');
const { buildUrl: _buildBase } = require('../config/urlBuilder');
const { notifyClient } = require('../services/notifyClient');
const { sanitizeErrorResponse } = require('../middlewares/objectAuthorization');
const { DeliveryOrderTracker } = require('../services/DeliveryOrderTracker');

const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const { redisDel, getRedisClient } = require('../config/redis');
const { resolveOrderIds } = require('../utils/orderIdResolver');
const logger = require('../utils/logger');

async function purgeOrderTripCaches(orderId) {
    if (!orderId) return;
    try {
        const idInfo = await resolveOrderIds(orderId);
        const allIds = idInfo.allIds.length > 0 ? idInfo.allIds : [String(orderId).trim()];
        const redis = getRedisClient();
        await Promise.all(allIds.map(async (id) => {
            await redisDel(`active_route:${id}`);
            if (redis) {
                const keys = await redis.keys(`trip:start:${id}:*`);
                if (keys && keys.length > 0) {
                    await Promise.all(keys.map(k => redisDel(k)));
                }
            }
        }));
    } catch (e) {
        logger.warn(`[TaskController] purgeOrderTripCaches error: ${e.message}`);
    }
}

// ─── Multer — حفظ الصور في Cloudinary (mashawerr/order-photos/) ────────────────────────────
const storage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
        const orderId = req.params.orderId || 'unknown_order';
        const taskId = req.params.taskId || 'unknown_task';
        return {
            folder: 'mashawerr/order-photos',
            public_id: `order_${orderId}_task_${taskId}_${Date.now()}`,
            overwrite: true,
            resource_type: 'image',
            transformation: [{ width: 1000, quality: 'auto', fetch_format: 'auto' }],
        };
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
        allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only JPEG/PNG/WebP allowed'));
    },
});

// ─── Helper: find task by taskId ─────────────────────────────────────────────
function findTask(order, taskId) {
    if (!Array.isArray(order.tasks) || order.tasks.length === 0) return null;
    return order.tasks.find((t) => t.taskId === taskId) ||
           order.tasks.find((t) => String(t.taskId) === String(taskId)) ||
           order.tasks.find((t) => String(t._id) === String(taskId)) ||
           (order.tasks.length === 1 ? order.tasks[0] : null);
}

// ─── Helper: emit socket event ────────────────────────────────────────────────
function emitSocket(req, room, event, data) {
    try {
        const io = req.app.get('io');
        if (io) {
            io.to(room).emit(event, data);
            console.log(`[Socket.IO] Emitted ${event} to ${room}`);
        }
    } catch (e) {
        console.error('[Socket.IO] emit error:', e.message);
    }
}

const mongoose = require('mongoose');

// ─── Helper: flexible order lookup (numeric ID, ObjectId, or string) ───────────
async function findOrderDoc(rawId) {
    if (!rawId) return null;
    const strId = String(rawId).trim();
    const numId = Number(strId);
    if (!isNaN(numId) && numId > 0) {
        const o = await Order.findOne({ orderId: numId });
        if (o) return o;
    }
    if (mongoose.isValidObjectId(strId)) {
        const o = await Order.findOne({ _id: strId });
        if (o) return o;
    }
    return await Order.findOne({ orderId: strId });
}

// ─── Helper: check if order is passenger / ride order ─────────────────────────
function isPassengerOrder(order) {
    if (!order) return false;
    const cat = String(order.orderCategory || order.order_category || order.category || '').toLowerCase().trim();
    if (['passenger', 'ladies', 'توصيل أفراد', 'توصيل افراد', 'توصيل ركاب', 'ركاب', 'سيدات'].includes(cat)) {
        return true;
    }
    const type = String(order.orderType || order.order_type || order.type || '').toLowerCase().trim();
    if (['passenger', 'ladies', 'توصيل أفراد', 'توصيل افراد', 'توصيل ركاب', 'ركاب', 'سيدات'].includes(type)) {
        return true;
    }
    if (order.is_ladies_only === true || order.isLadiesOnly === true) {
        return true;
    }
    const desc = String(order.deliveryDescription || order.itemDescription || '').toLowerCase();
    if (desc.includes('توصيل أفراد') || desc.includes('توصيل افراد') || desc.includes('passenger') || desc.includes('سيدات') || desc.includes('ركاب')) {
        return true;
    }
    if (Array.isArray(order.tasks)) {
        for (const t of order.tasks) {
            const tCat = String(t.orderCategory || t.category || '').toLowerCase().trim();
            if (['passenger', 'ladies', 'توصيل أفراد', 'توصيل افراد', 'ركاب', 'سيدات'].includes(tCat)) return true;
            const tType = String(t.orderType || t.type || '').toLowerCase().trim();
            if (['passenger', 'ladies', 'توصيل أفراد', 'توصيل افراد', 'ركاب', 'سيدات'].includes(tType)) return true;
            const tDesc = String(t.deliveryDescription || t.itemDescription || '').toLowerCase();
            if (tDesc.includes('توصيل أفراد') || tDesc.includes('توصيل افراد') || tDesc.includes('passenger') || tDesc.includes('سيدات')) return true;
        }
    }
    return false;
}

// ─── Helper: Broadcast to all relevant order rooms ────────────────────────────
function broadcastToOrderRooms(req, order, rawOrderId, event, data) {
    const rooms = new Set([
        order.orderId != null ? `order:${order.orderId}` : null,
        order._id ? `order:${order._id}` : null,
        rawOrderId ? `order:${rawOrderId}` : null,
        order.orderId != null ? `trip:${order.orderId}` : null,
        order._id ? `trip:${order._id}` : null,
        rawOrderId ? `trip:${rawOrderId}` : null,
        order.clientId ? `user:${order.clientId}` : null,
        order.userId ? `user:${order.userId}` : null,
    ].filter(Boolean));

    for (const r of rooms) {
        emitSocket(req, r, event, data);
    }
}

/**
 * @description Mark task as picked_up (تم الاستلام)
 *   - Sets task.taskStatus = 'picked_up'
 *   - Sets task.arrivedAt = now
 *   - Emits task:picked_up, order:status_changed, order:track_updated via Socket.IO
 *
 * @route PATCH /api/orders/:orderId/tasks/:taskId/pickup
 */
const markTaskPickedUp = asyncHandler(async (req, res) => {
    const rawOrderId = req.params.orderId;
    const rawTaskId  = req.params.taskId;

    if (!rawOrderId) {
        return res.status(400).json({ message: 'orderId is required' });
    }

    if (process.env.TEST_MODE === 'true' && mongoose.connection.readyState !== 1) {
        return sanitizeErrorResponse(res, true, true);
    }

    const order = await findOrderDoc(rawOrderId);
    if (!order) return sanitizeErrorResponse(res, false, true);

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isRep = (order.representativeId && order.representativeId.toString() === req.user?.id?.toString()) ||
                  (order.driverId && order.driverId.toString() === req.user?.id?.toString());
    const isClient = (order.clientId && order.clientId.toString() === req.user?.id?.toString()) ||
                     (order.userId && order.userId.toString() === req.user?.id?.toString());
    if (!isRep && !isClient && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    // Ensure tasks array is present
    if (!Array.isArray(order.tasks) || order.tasks.length === 0) {
        order.tasks = [{
            taskId: 1,
            taskStatus: 'pending',
            type: 'delivery',
        }];
    }

    const parsedTaskId = parseInt(rawTaskId, 10);
    const lookupTaskId = isNaN(parsedTaskId) ? rawTaskId : parsedTaskId;
    const task = findTask(order, lookupTaskId) || order.tasks[0];
    if (!task) return sanitizeErrorResponse(res, false, true);

    if (task.taskStatus === 'completed') {
        return res.status(409).json({ message: 'Task is already completed' });
    }

    const now = new Date();
    task.taskStatus = 'picked_up';
    task.status     = 'picked_up';
    task.isPickedUp = true;
    task.arrivedAt  = task.arrivedAt || now;
    task.pickedUpAt = now;
    if (!order.arrivalConfirmedAt) order.arrivalConfirmedAt = task.arrivedAt;
    if (!order.arrivedAt) order.arrivedAt = task.arrivedAt;

    // 🎯 تحديث محطة الاستلام في allLocationsInOrder إن وجدت
    if (Array.isArray(order.allLocationsInOrder) && order.allLocationsInOrder.length > 0) {
        const rawStopIdx = req.body?.stopIndex ?? req.query?.stopIndex;
        let targetStop = null;
        if (rawStopIdx !== undefined && rawStopIdx !== null) {
            const idx = parseInt(rawStopIdx, 10);
            const candidate = order.allLocationsInOrder[idx];
            if (candidate && (candidate.isFrom === true || candidate.isFrom === 'true')) {
                targetStop = candidate;
            }
        }
        if (!targetStop) {
            targetStop = order.allLocationsInOrder.find(l => (l.isFrom === true || l.isFrom === 'true') && !l.isCompleted);
        }
        if (targetStop) {
            targetStop.isCompleted = true;
            targetStop.completedAt = new Date();
        }
        order.markModified('allLocationsInOrder');
    }

    const allPickupsDone = !Array.isArray(order.tasks) || order.tasks.every(t => t.taskStatus === 'picked_up' || t.status === 'picked_up' || t.taskStatus === 'completed' || t.isPickedUp);
    if (allPickupsDone && (order.status === 'accepted' || order.status === 'waiting' || order.status === 'assigned' || order.status === 'processing' || order.status === 'confirmed' || order.status === '1')) {
        order.status = 'delivering';
    }

    await order.save();

    const trackData = await DeliveryOrderTracker.getOrderTrack(order).catch(() => null);
    const effectiveOrderId = order.orderId ?? rawOrderId;
    const isPassenger = isPassengerOrder(order);

    // 🧹 Purge Redis active route and trip start locks for fresh navigation to next stop
    await purgeOrderTripCaches(effectiveOrderId);

    // 🎯 Broadcast to ALL order & user rooms
    const pickedUpPayload = {
        orderId: effectiveOrderId,
        taskId: task.taskId ?? lookupTaskId ?? 1,
        taskStatus: 'picked_up',
        arrivedAt: task.arrivedAt,
        message: isPassenger ? 'تم بدء الرحلة مع الراكب 🚗' : 'تم استلام البضاعة',
        track: trackData,
        phase: 'DELIVERY',
        allPickupsDone,
    };
    broadcastToOrderRooms(req, order, rawOrderId, 'task:picked_up', pickedUpPayload);

    const statusPayload = {
        orderId: effectiveOrderId,
        status: order.status || 'delivering',
        phase: 'DELIVERY',
        message: isPassenger ? 'تم بدء الرحلة — في الطريق إلى وجهتك 🚗' : 'تم بدء مرحلة التسليم',
        track: trackData,
        allPickupsDone,
    };
    broadcastToOrderRooms(req, order, rawOrderId, 'order:status_changed', statusPayload);

    if (trackData) {
        const trackPayload = {
            orderId: effectiveOrderId,
            track: trackData,
            currentStopIndex: trackData.currentStopIndex,
            phase: trackData.phase,
            stops: trackData.stops,
        };
        broadcastToOrderRooms(req, order, rawOrderId, 'order:track_updated', trackPayload);
    }

    // ─── إشعار FCM للعميل ────────────────────────────────────────────────────
    const clientToNotify = order.clientId || order.userId;
    if (clientToNotify) {
        const notifTitle = isPassenger ? '🚗 بدأت رحلتك' : '📦 تم استلام طلبك';
        const notifBody = isPassenger
            ? 'المندوب أكد ركوبك — في الطريق إلى وجهتك 🚗'
            : 'المندوب استلم البضاعة — في الطريق إليك';

        notifyClient(
            clientToNotify,
            notifTitle,
            notifBody,
            {
                type: 'task_picked_up',
                orderId: String(effectiveOrderId),
                isPassenger: String(isPassenger),
            },
        ).catch(() => {});
    }

    return res.status(200).json({
        succeeded: true,
        orderId: effectiveOrderId,
        taskId: task.taskId ?? lookupTaskId ?? 1,
        taskStatus: task.taskStatus,
        arrivedAt: task.arrivedAt,
        status: order.status,
        track: trackData,
    });
});

/**
 * @description Upload before-pickup photo (بيفور فوتو) — multipart/form-data
 *   field: photo (image file)
 *   Sets task.itemPhotoBefore
 *
 * @route POST /api/orders/:orderId/tasks/:taskId/photo/before
 */
const uploadPhotoBeforeHandler = upload.single('photo');
const uploadPhotoBefore = [
    (req, res, next) => uploadPhotoBeforeHandler(req, res, next),
    asyncHandler(async (req, res) => {
        const rawOrderId = req.params.orderId;
        const rawTaskId  = req.params.taskId;

        if (!rawOrderId) {
            return res.status(400).json({ message: 'orderId is required' });
        }
        if (!req.file) {
            return res.status(400).json({ message: 'photo file is required' });
        }

        const order = await findOrderDoc(rawOrderId);
        if (!order) return sanitizeErrorResponse(res, false, true);

        const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
        const isRep = (order.representativeId && order.representativeId.toString() === req.user?.id?.toString()) ||
                      (order.driverId && order.driverId.toString() === req.user?.id?.toString());
        const isClient = (order.clientId && order.clientId.toString() === req.user?.id?.toString()) ||
                         (order.userId && order.userId.toString() === req.user?.id?.toString());
        if (!isRep && !isClient && !isAdmin) {
            return sanitizeErrorResponse(res, true, true);
        }

        if (!Array.isArray(order.tasks) || order.tasks.length === 0) {
            order.tasks = [{ taskId: 1, taskStatus: 'pending', type: 'delivery' }];
        }

        const parsedTaskId = parseInt(rawTaskId, 10);
        const lookupTaskId = isNaN(parsedTaskId) ? rawTaskId : parsedTaskId;
        const task = findTask(order, lookupTaskId) || order.tasks[0];
        if (!task) return sanitizeErrorResponse(res, false, true);

        task.itemPhotoBefore = req.file.path;
        if (!order.pickupPhoto) order.pickupPhoto = req.file.path;
        if (!order.itemPhotoBefore) order.itemPhotoBefore = req.file.path;

        // 🎯 تحديث محطة الاستلام في allLocationsInOrder وحفظ الصورة
        if (Array.isArray(order.allLocationsInOrder) && order.allLocationsInOrder.length > 0) {
            const rawStopIdx = req.body?.stopIndex ?? req.query?.stopIndex;
            let targetStop = null;
            if (rawStopIdx !== undefined && rawStopIdx !== null) {
                const idx = parseInt(rawStopIdx, 10);
                const candidate = order.allLocationsInOrder[idx];
                if (candidate && (candidate.isFrom === true || candidate.isFrom === 'true')) {
                    targetStop = candidate;
                }
            }
            if (!targetStop) {
                targetStop = order.allLocationsInOrder.find(l => (l.isFrom === true || l.isFrom === 'true') && !l.isCompleted);
            }
            if (targetStop) {
                targetStop.pickupPhoto = req.file.path;
            }
            order.markModified('allLocationsInOrder');
        }

        await order.save();

        const trackData = await DeliveryOrderTracker.getOrderTrack(order).catch(() => null);
        const effectiveOrderId = order.orderId ?? rawOrderId;

        if (trackData) {
            broadcastToOrderRooms(req, order, rawOrderId, 'order:track_updated', {
                orderId: effectiveOrderId,
                track: trackData,
                currentStopIndex: trackData.currentStopIndex,
                phase: trackData.phase,
                stops: trackData.stops,
            });
        }

        return res.status(200).json({
            succeeded: true,
            orderId: effectiveOrderId,
            taskId: task.taskId ?? lookupTaskId ?? 1,
            itemPhotoBefore: task.itemPhotoBefore,
            track: trackData,
        });
    }),
];

/**
 * @description Mark task as completed (تم التسليم) + upload after-delivery photo
 *   - Sets task.taskStatus = 'completed'
 *   - Sets task.deliveredAt = now
 *   - Saves itemPhotoAfter (optional multipart/form-data field: photo)
 *   - If ALL tasks completed → order.status = 'completed'
 *   - Emits task:delivered + (if all done) order:completed via Socket.IO
 *
 * @route POST /api/orders/:orderId/tasks/:taskId/deliver
 */
const deliverTaskHandler = upload.single('photo');
const deliverTask = [
    (req, res, next) => deliverTaskHandler(req, res, next),
    asyncHandler(async (req, res) => {
        const rawOrderId = req.params.orderId;
        const rawTaskId  = req.params.taskId;

        if (!rawOrderId) {
            return res.status(400).json({ message: 'orderId is required' });
        }

        const order = await findOrderDoc(rawOrderId);
        if (!order) return sanitizeErrorResponse(res, false, true);

        const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
        const isRep = (order.representativeId && order.representativeId.toString() === req.user?.id?.toString()) ||
                      (order.driverId && order.driverId.toString() === req.user?.id?.toString());
        const isClient = (order.clientId && order.clientId.toString() === req.user?.id?.toString()) ||
                         (order.userId && order.userId.toString() === req.user?.id?.toString());
        if (!isRep && !isClient && !isAdmin) {
            return sanitizeErrorResponse(res, true, true);
        }

        if (!Array.isArray(order.tasks) || order.tasks.length === 0) {
            order.tasks = [{ taskId: 1, taskStatus: 'pending', type: 'delivery' }];
        }

        const parsedTaskId = parseInt(rawTaskId, 10);
        const lookupTaskId = isNaN(parsedTaskId) ? rawTaskId : parsedTaskId;
        const task = findTask(order, lookupTaskId) || order.tasks[0];
        if (!task) return sanitizeErrorResponse(res, false, true);

        if (task.taskStatus === 'completed') {
            return res.status(409).json({ message: 'Task is already completed' });
        }

        // حفظ صورة ما بعد التسليم (اختيارية)
        if (req.file) {
            task.itemPhotoAfter = req.file.path;
            if (!order.deliveryPhoto) order.deliveryPhoto = req.file.path;
            if (!order.itemPhotoAfter) order.itemPhotoAfter = req.file.path;
        }

        const now = new Date();
        task.taskStatus  = 'completed';
        task.deliveredAt = task.deliveredAt || now;
        task.completedAt = task.completedAt || now;

        // 🎯 تحديث محطة التسليم في allLocationsInOrder وحفظ الصورة
        if (Array.isArray(order.allLocationsInOrder) && order.allLocationsInOrder.length > 0) {
            const rawStopIdx = req.body?.stopIndex ?? req.query?.stopIndex;
            let targetStop = null;
            if (rawStopIdx !== undefined && rawStopIdx !== null) {
                const idx = parseInt(rawStopIdx, 10);
                const candidate = order.allLocationsInOrder[idx];
                if (candidate && (candidate.isFrom === false || candidate.isFrom === 'false')) {
                    targetStop = candidate;
                }
            }
            if (!targetStop) {
                targetStop = order.allLocationsInOrder.find(l => (l.isFrom === false || l.isFrom === 'false') && !l.isCompleted);
            }
            if (targetStop) {
                targetStop.isCompleted = true;
                if (req.file) targetStop.deliveryPhoto = req.file.path;
                targetStop.completedAt = now;
            }

            // 🛡️ Only pickup locations up to the delivered stop should be assumed completed
            const deliveredIdx = targetStop ? order.allLocationsInOrder.indexOf(targetStop) : order.allLocationsInOrder.length;
            for (let i = 0; i < deliveredIdx; i++) {
                const loc = order.allLocationsInOrder[i];
                if (loc && (loc.isFrom === true || loc.isFrom === 'true')) {
                    loc.isCompleted = true;
                    loc.completedAt = loc.completedAt || now;
                }
            }

            order.markModified('allLocationsInOrder');
        }

        // هل جميع المهام اكتملت؟
        const dropoffStops = Array.isArray(order.allLocationsInOrder) && order.allLocationsInOrder.length > 0
            ? order.allLocationsInOrder.filter(l => l.isFrom === false || l.isFrom === 'false')
            : [];
        const allDropoffsDone = dropoffStops.length > 0 && dropoffStops.every(l => l.isCompleted === true);
        const hasTasks = Array.isArray(order.tasks) && order.tasks.length > 0;
        const allTasksDone = hasTasks && order.tasks.every((t) => t.taskStatus === 'completed');
        const isFinalStopParam = req.body?.isFinalStop === true || req.body?.isFinalStop === 'true' || req.query?.isFinalStop === 'true';

        let allDone = false;
        if (isFinalStopParam) {
            allDone = true;
        } else if (dropoffStops.length > 0) {
            // In multi-destination routes, ALL dropoff stops MUST be completed!
            allDone = allDropoffsDone && (hasTasks ? allTasksDone : true);
        } else if (hasTasks) {
            allDone = allTasksDone;
        } else {
            allDone = true;
        }

        if (allDone) {
            order.status = 'completed';
            order.deliveredAt = order.deliveredAt || now;
            order.completedAt = order.completedAt || now;

            // Make sure EVERY stop in allLocationsInOrder is marked completed
            if (Array.isArray(order.allLocationsInOrder)) {
                for (const loc of order.allLocationsInOrder) {
                    loc.isCompleted = true;
                    loc.completedAt = loc.completedAt || now;
                }
                order.markModified('allLocationsInOrder');
            }

            const { processOrderCompletionWallet } = require('../middlewares/Wallet');
            await processOrderCompletionWallet(order).catch((e) => console.error('[taskController] Wallet error:', e.message));
        }

        await order.save();

        const trackData = await DeliveryOrderTracker.getOrderTrack(order).catch(() => null);
        const effectiveOrderId = order.orderId ?? rawOrderId;
        const isPassenger = isPassengerOrder(order);

        // 🧹 Purge Redis active route and trip start locks for fresh navigation to next stop
        await purgeOrderTripCaches(effectiveOrderId);

        // إشعار: تم التسليم للتاسك
        broadcastToOrderRooms(req, order, rawOrderId, 'task:delivered', {
            orderId: effectiveOrderId,
            taskId: task.taskId ?? lookupTaskId ?? 1,
            taskStatus: 'completed',
            deliveredAt: task.deliveredAt,
            itemPhotoAfter: task.itemPhotoAfter || null,
            allTasksCompleted: allDone,
            message: isPassenger ? 'تم الوصول إلى الوجهة بنجاح 🏁' : 'تم تسليم البضاعة',
            track: trackData,
        });

        if (trackData) {
            broadcastToOrderRooms(req, order, rawOrderId, 'order:track_updated', {
                orderId: effectiveOrderId,
                track: trackData,
                currentStopIndex: trackData.currentStopIndex,
                phase: trackData.phase,
                stops: trackData.stops,
            });
        }

        // إشعار: الأوردر كله اكتمل
        if (allDone) {
            broadcastToOrderRooms(req, order, rawOrderId, 'order:completed', {
                orderId: effectiveOrderId,
                status: 'completed',
                message: isPassenger
                    ? 'تم إنهاء الرحلة بنجاح 🎉 نتمنى لك يوماً سعيداً!'
                    : 'تم إتمام جميع مهام الطلب بنجاح 🎉',
                track: trackData,
            });
            broadcastToOrderRooms(req, order, rawOrderId, 'order:status_changed', {
                orderId: effectiveOrderId,
                status: 'completed',
                message: isPassenger
                    ? 'تم إنهاء الرحلة بنجاح 🎉'
                    : 'تم إتمام جميع مهام الطلب بنجاح 🎉',
                track: trackData,
            });
        }

        // ─── إشعار FCM وإيميل للعميل عند إتمام الطلب بالكامل ────────────────
        const clientToNotify = order.clientId || order.userId;
        if (allDone) {
            if (clientToNotify) {
                const compTitle = isPassenger ? '🎉 تم إنهاء الرحلة بنجاح' : '🎉 تم تسليم طلبك بنجاح';
                const compBody = isPassenger
                    ? 'وصلت إلى وجهتك بالسلامة، شكراً لاستخدامك مشاوير!'
                    : 'تم إتمام جميع مهام الطلب بنجاح!';

                notifyClient(
                    clientToNotify,
                    compTitle,
                    compBody,
                    {
                        type: 'order_completed',
                        orderId: String(effectiveOrderId),
                        isPassenger: String(isPassenger),
                    },
                ).catch(() => {});
            }

            // ─── إرسال بريد إلكتروني لاكتمال الطلب في الخلفية (Non-blocking) ───
            const { sendDeliveryOrderCompletionEmail, dispatchBackgroundEmail } = require('../services/emailService');
            dispatchBackgroundEmail(async () => {
                await sendDeliveryOrderCompletionEmail(order);
            });
        } else {
            if (clientToNotify) {
                const partTitle = isPassenger ? '📍 تم الوصول لمحطة من المشوار' : '✅ تم تسليم جزء من طلبك';
                const partBody = isPassenger
                    ? 'المندوب وصل إلى محطة من مسار الرحلة'
                    : 'تم تسليم مهمة من الطلب';

                notifyClient(
                    clientToNotify,
                    partTitle,
                    partBody,
                    {
                        type: 'task_delivered',
                        orderId: String(effectiveOrderId),
                        isPassenger: String(isPassenger),
                    },
                ).catch(() => {});
            }
        }

        return res.status(200).json({
            succeeded: true,
            orderId: effectiveOrderId,
            taskId: task.taskId ?? lookupTaskId ?? 1,
            taskStatus: task.taskStatus,
            deliveredAt: task.deliveredAt,
            itemPhotoAfter: task.itemPhotoAfter || null,
            allTasksCompleted: allDone,
            orderStatus: order.status,
            track: trackData,
        });
    }),
];

/**
 * @description Get task status only (lightweight)
 * @route GET /api/orders/:orderId/tasks/:taskId/status
 */
const getTaskStatus = asyncHandler(async (req, res) => {
    const rawOrderId = req.params.orderId;
    const rawTaskId  = req.params.taskId;

    if (!rawOrderId) {
        return res.status(400).json({ message: 'orderId is required' });
    }

    const order = await findOrderDoc(rawOrderId);
    if (!order) return sanitizeErrorResponse(res, false, true);

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isRep = (order.representativeId && order.representativeId.toString() === req.user?.id?.toString()) ||
                  (order.driverId && order.driverId.toString() === req.user?.id?.toString());
    const isClient = (order.clientId && order.clientId.toString() === req.user?.id?.toString()) ||
                     (order.userId && order.userId.toString() === req.user?.id?.toString());
    if (!isRep && !isClient && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const parsedTaskId = parseInt(rawTaskId, 10);
    const lookupTaskId = isNaN(parsedTaskId) ? rawTaskId : parsedTaskId;
    const task = findTask(order, lookupTaskId) || (Array.isArray(order.tasks) && order.tasks[0]);
    if (!task) return sanitizeErrorResponse(res, false, true);

    return res.status(200).json({
        orderId: order.orderId ?? rawOrderId,
        taskId: task.taskId ?? lookupTaskId ?? 1,
        taskStatus: task.taskStatus ?? 'pending',
        arrivedAt: task.arrivedAt ?? null,
        deliveredAt: task.deliveredAt ?? null,
        itemPhotoBefore: task.itemPhotoBefore || null,
        itemPhotoAfter: task.itemPhotoAfter || null,
    });
});

module.exports = {
    markTaskPickedUp,
    uploadPhotoBefore,
    deliverTask,
    getTaskStatus,
};
