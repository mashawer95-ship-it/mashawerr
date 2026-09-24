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
    return order.tasks.find((t) => t.taskId === taskId);
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


/**
 * @description Mark task as picked_up (تم الاستلام)
 *   - Sets task.taskStatus = 'picked_up'
 *   - Sets task.arrivedAt = now
 *   - Emits task:picked_up via Socket.IO
 *
 * @route PATCH /api/orders/:orderId/tasks/:taskId/pickup
 */
const markTaskPickedUp = asyncHandler(async (req, res) => {
    const orderId = parseInt(req.params.orderId, 10);
    const taskId  = parseInt(req.params.taskId,  10);

    if (isNaN(orderId) || isNaN(taskId)) {
        return res.status(400).json({ message: 'orderId and taskId must be positive integers' });
    }

    const mongoose = require('mongoose');
    if (process.env.TEST_MODE === 'true' && mongoose.connection.readyState !== 1) {
        return sanitizeErrorResponse(res, true, true);
    }

    const order = await Order.findOne({ orderId });
    if (!order) return sanitizeErrorResponse(res, false, true);

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isRep = order.representativeId && order.representativeId.toString() === req.user?.id?.toString();
    const isClient = order.clientId && order.clientId.toString() === req.user?.id?.toString();
    if (!isRep && !isClient && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const task = findTask(order, taskId);
    if (!task) return sanitizeErrorResponse(res, false, true);

    if (task.taskStatus === 'completed') {
        return res.status(409).json({ message: 'Task is already completed' });
    }

    task.taskStatus = 'picked_up';
    task.arrivedAt  = new Date();

    // 🎯 تحديث محطة الاستلام في allLocationsInOrder إن وجدت
    if (Array.isArray(order.allLocationsInOrder) && order.allLocationsInOrder.length > 0) {
        const rawStopIdx = req.body?.stopIndex ?? req.query?.stopIndex;
        let targetStop = null;
        if (rawStopIdx !== undefined && rawStopIdx !== null && order.allLocationsInOrder[parseInt(rawStopIdx, 10)]) {
            targetStop = order.allLocationsInOrder[parseInt(rawStopIdx, 10)];
        }
        if (!targetStop) {
            targetStop = order.allLocationsInOrder.find(l => l.isFrom === true && !l.isCompleted);
        }
        if (targetStop) {
            targetStop.isCompleted = true;
            targetStop.completedAt = new Date();
        }
        order.markModified('allLocationsInOrder');
    }

    await order.save();

    const trackData = await DeliveryOrderTracker.getOrderTrack(order).catch(() => null);

    const room = `order:${orderId}`;
    emitSocket(req, room, 'task:picked_up', {
        orderId,
        taskId,
        taskStatus: 'picked_up',
        arrivedAt: task.arrivedAt,
        message: 'تم استلام البضاعة',
        track: trackData,
    });

    if (trackData) {
        emitSocket(req, room, 'order:track_updated', {
            orderId,
            track: trackData,
            currentStopIndex: trackData.currentStopIndex,
            phase: trackData.phase,
            stops: trackData.stops,
        });
    }

    // ─── إشعار FCM للعميل ────────────────────────────────────────────────────
    notifyClient(
        order.clientId,
        '📦 تم استلام طلبك',
        `المندوب استلم البضاعة — في الطريق إليك`,
        { type: 'task_picked_up', orderId: String(orderId) },
    ).catch(() => {});

    return res.status(200).json({
        succeeded: true,
        orderId,
        taskId,
        taskStatus: task.taskStatus,
        arrivedAt: task.arrivedAt,
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
        const orderId = parseInt(req.params.orderId, 10);
        const taskId  = parseInt(req.params.taskId,  10);

        if (isNaN(orderId) || isNaN(taskId)) {
            return res.status(400).json({ message: 'Invalid orderId or taskId' });
        }
        if (!req.file) {
            return res.status(400).json({ message: 'photo file is required' });
        }

        const order = await Order.findOne({ orderId });
        if (!order) return sanitizeErrorResponse(res, false, true);

        const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
        const isRep = order.representativeId && order.representativeId.toString() === req.user?.id?.toString();
        const isClient = order.clientId && order.clientId.toString() === req.user?.id?.toString();
        if (!isRep && !isClient && !isAdmin) {
            return sanitizeErrorResponse(res, true, true);
        }

        const task = findTask(order, taskId);
        if (!task) return sanitizeErrorResponse(res, false, true);

        task.itemPhotoBefore = req.file.path;
        if (!order.pickupPhoto) order.pickupPhoto = req.file.path;
        if (!order.itemPhotoBefore) order.itemPhotoBefore = req.file.path;

        // 🎯 تحديث محطة الاستلام في allLocationsInOrder وحفظ الصورة
        if (Array.isArray(order.allLocationsInOrder) && order.allLocationsInOrder.length > 0) {
            const rawStopIdx = req.body?.stopIndex ?? req.query?.stopIndex;
            let targetStop = null;
            if (rawStopIdx !== undefined && rawStopIdx !== null && order.allLocationsInOrder[parseInt(rawStopIdx, 10)]) {
                targetStop = order.allLocationsInOrder[parseInt(rawStopIdx, 10)];
            }
            if (!targetStop) {
                targetStop = order.allLocationsInOrder.find(l => l.isFrom === true && !l.isCompleted);
            }
            if (targetStop) {
                targetStop.pickupPhoto = req.file.path;
            }
            order.markModified('allLocationsInOrder');
        }

        await order.save();

        const trackData = await DeliveryOrderTracker.getOrderTrack(order).catch(() => null);

        const room = `order:${orderId}`;
        if (trackData) {
            emitSocket(req, room, 'order:track_updated', {
                orderId,
                track: trackData,
                currentStopIndex: trackData.currentStopIndex,
                phase: trackData.phase,
                stops: trackData.stops,
            });
        }

        return res.status(200).json({
            succeeded: true,
            orderId,
            taskId,
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
        const orderId = parseInt(req.params.orderId, 10);
        const taskId  = parseInt(req.params.taskId,  10);

        if (isNaN(orderId) || isNaN(taskId)) {
            return res.status(400).json({ message: 'Invalid orderId or taskId' });
        }

        const order = await Order.findOne({ orderId });
        if (!order) return sanitizeErrorResponse(res, false, true);

        const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
        const isRep = order.representativeId && order.representativeId.toString() === req.user?.id?.toString();
        const isClient = order.clientId && order.clientId.toString() === req.user?.id?.toString();
        if (!isRep && !isClient && !isAdmin) {
            return sanitizeErrorResponse(res, true, true);
        }

        const task = findTask(order, taskId);
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

        task.taskStatus  = 'completed';
        task.deliveredAt = new Date();

        // 🎯 تحديث محطة التسليم في allLocationsInOrder وحفظ الصورة
        if (Array.isArray(order.allLocationsInOrder) && order.allLocationsInOrder.length > 0) {
            const rawStopIdx = req.body?.stopIndex ?? req.query?.stopIndex;
            let targetStop = null;
            if (rawStopIdx !== undefined && rawStopIdx !== null && order.allLocationsInOrder[parseInt(rawStopIdx, 10)]) {
                targetStop = order.allLocationsInOrder[parseInt(rawStopIdx, 10)];
            }
            if (!targetStop) {
                targetStop = order.allLocationsInOrder.find(l => l.isFrom === false && !l.isCompleted);
            }
            if (targetStop) {
                targetStop.isCompleted = true;
                if (req.file) targetStop.deliveryPhoto = req.file.path;
                targetStop.completedAt = new Date();
            }
            order.markModified('allLocationsInOrder');
        }

        // هل جميع المهام اكتملت؟
        let allDone = false;
        if (Array.isArray(order.allLocationsInOrder) && order.allLocationsInOrder.length > 0) {
            allDone = order.allLocationsInOrder.every(l => l.isCompleted === true);
        } else {
            allDone = order.tasks.every((t) => t.taskStatus === 'completed');
        }

        if (allDone) {
            order.status = 'completed';
            const { processOrderCompletionWallet } = require('../middlewares/Wallet');
            await processOrderCompletionWallet(order).catch((e) => console.error('[taskController] Wallet error:', e.message));
        }

        await order.save();

        const trackData = await DeliveryOrderTracker.getOrderTrack(order).catch(() => null);

        const room = `order:${orderId}`;

        // إشعار: تم التسليم للتاسك
        emitSocket(req, room, 'task:delivered', {
            orderId,
            taskId,
            taskStatus: 'completed',
            deliveredAt: task.deliveredAt,
            itemPhotoAfter: task.itemPhotoAfter || null,
            allTasksCompleted: allDone,
            message: 'تم تسليم البضاعة',
            track: trackData,
        });

        if (trackData) {
            emitSocket(req, room, 'order:track_updated', {
                orderId,
                track: trackData,
                currentStopIndex: trackData.currentStopIndex,
                phase: trackData.phase,
                stops: trackData.stops,
            });
        }

        // إشعار: الأوردر كله اكتمل
        if (allDone) {
            emitSocket(req, room, 'order:completed', {
                orderId,
                status: 'completed',
                message: 'تم إتمام جميع مهام الطلب بنجاح 🎉',
                track: trackData,
            });
        }

        // ─── إشعار FCM وإيميل للعميل عند إتمام الطلب بالكامل ────────────────
        if (allDone) {
            notifyClient(
                order.clientId,
                '🎉 تم تسليم طلبك بنجاح',
                `تم إتمام جميع مهام الطلب بنجاح!`,
                { type: 'order_completed', orderId: String(orderId) },
            ).catch(() => {});

            // ─── إرسال بريد إلكتروني لاكتمال الطلب في الخلفية (Non-blocking) ───
            const { sendDeliveryOrderCompletionEmail, dispatchBackgroundEmail } = require('../services/emailService');
            dispatchBackgroundEmail(async () => {
                await sendDeliveryOrderCompletionEmail(order);
            });
        } else {
            notifyClient(
                order.clientId,
                '✅ تم تسليم جزء من طلبك',
                `تم تسليم مهمة من الطلب`,
                { type: 'task_delivered', orderId: String(orderId) },
            ).catch(() => {});
        }

        return res.status(200).json({
            succeeded: true,
            orderId,
            taskId,
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
    const orderId = parseInt(req.params.orderId, 10);
    const taskId  = parseInt(req.params.taskId,  10);

    if (isNaN(orderId) || isNaN(taskId)) {
        return res.status(400).json({ message: 'Invalid orderId or taskId' });
    }

    const order = await Order.findOne({ orderId }).lean();
    if (!order) return sanitizeErrorResponse(res, false, true);

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    const isRep = order.representativeId && order.representativeId.toString() === req.user?.id?.toString();
    const isClient = order.clientId && order.clientId.toString() === req.user?.id?.toString();
    if (!isRep && !isClient && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const task = order.tasks.find((t) => t.taskId === taskId);
    if (!task) return sanitizeErrorResponse(res, false, true);

    return res.status(200).json({
        orderId,
        taskId,
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
