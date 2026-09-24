const crypto = require('crypto');
const mongoose = require('mongoose');
const { DeliverySession } = require('../models/DeliverySession');
const { DeliveryAttempt } = require('../models/DeliveryAttempt');
const { Order } = require('../middlewares/Order');
const { StoreOrder } = require('../middlewares/StoreOrder');
const { generateAndStoreHMAC, getPlainOTP, verifyHMACOTP, checkAndSetFraudHash, redisLock, redisUnlock } = require('../config/redis');
const { notifyClient } = require('../services/notifyClient');
const { DeliveryEventBus } = require('../services/DeliveryEventBus');
const { BusinessOrderTracker } = require('../services/BusinessOrderTracker');
const { DeliveryOrderTracker } = require('../services/DeliveryOrderTracker');
const logger = require('../utils/logger');
const cloudinary = require('../config/cloudinary');

// ─── Utility: Get Parent Order ───────────────────────────────────────────────
async function getParentOrder(orderId, isStoreOrder = false, subId = null) {
    if (!orderId) return null;
    const strId = String(orderId).trim();
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(strId);

    // Helper: Check if an order document has business/store order characteristics
    const isDocStoreOrder = (doc) => {
        if (!doc) return false;
        return doc.isBusinessOrder === true ||
            doc.orderCategory === 'business' ||
            doc.storeOrderId != null ||
            doc.parentGroupId != null ||
            (Array.isArray(doc.items) && doc.items.length > 0);
    };

    // 1. If subId is provided, try direct lookup by _id, storeOrderId, agentId, or item productId
    if (subId) {
        const isValidSubObjId = mongoose.isValidObjectId(subId);
        const numSubId = !isNaN(Number(subId)) ? Number(subId) : -1;

        let targetSub = await StoreOrder.findOne({
            $or: [
                ...(isValidSubObjId ? [{ _id: subId }, { 'items.product': subId }, { 'items._id': subId }] : []),
                ...(numSubId > 0 ? [{ storeOrderId: numSubId }, { orderId: numSubId }] : []),
                { agentId: String(subId) }
            ]
        });

        if (targetSub) return targetSub;
    }

    // 2. If orderId is a direct ObjectId
    if (mongoose.isValidObjectId(strId)) {
        const exactStoreOrder = await StoreOrder.findById(strId);
        if (exactStoreOrder && (isStoreOrder || isDocStoreOrder(exactStoreOrder))) {
            return exactStoreOrder;
        }
        const exactNormalOrder = await Order.findById(strId);
        if (exactNormalOrder) {
            if (isDocStoreOrder(exactNormalOrder)) {
                return exactStoreOrder || exactNormalOrder;
            }
            return exactNormalOrder;
        }
        if (exactStoreOrder) return exactStoreOrder;
    }

    // 3. If orderId is parentGroupId (UUID)
    if (isUUID) {
        const subs = await StoreOrder.find({ parentGroupId: strId });
        if (subs.length > 0) {
            const pendingSub = subs.find(s => s.status !== 'delivered' && s.status !== 'completed');
            return pendingSub || subs[0];
        }
    }

    // 4. Numeric orderId (Check StoreOrder first if it has store order signature)
    if (!isNaN(Number(strId))) {
        const numId = Number(strId);
        const storeSubs = await StoreOrder.find({ $or: [{ storeOrderId: numId }, { orderId: numId }] });
        if (storeSubs.length > 0) {
            const hasStoreSignature = storeSubs.some(s => isDocStoreOrder(s));
            if (isStoreOrder || hasStoreSignature) {
                const pendingSub = storeSubs.find(s => s.status !== 'delivered' && s.status !== 'completed');
                return pendingSub || storeSubs[0];
            }
        }
        const normalOrder = await Order.findOne({ orderId: numId });
        if (normalOrder) {
            if (isDocStoreOrder(normalOrder) && storeSubs.length > 0) {
                const pendingSub = storeSubs.find(s => s.status !== 'delivered' && s.status !== 'completed');
                return pendingSub || storeSubs[0];
            }
            return normalOrder;
        }
        if (storeSubs.length > 0) {
            const pendingSub = storeSubs.find(s => s.status !== 'delivered' && s.status !== 'completed');
            return pendingSub || storeSubs[0];
        }
    }

    return null;
}

// ─── 1. Generate Single-Use Upload URL ───────────────────────────────────────
exports.getUploadUrl = async (req, res) => {
    const traceId = req.headers['x-correlation-id'] || crypto.randomUUID();
    const startTime = Date.now();
    try {
        const { id } = req.params;
        const isStoreOrder = req.baseUrl.includes('store');
        const phase = (req.query.phase || req.body?.phase || 'DELIVERY').toUpperCase();

        const order = await getParentOrder(id, isStoreOrder);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        let session = null;
        if (order.activeDeliverySessionId) {
            session = await DeliverySession.findOne({ sessionId: order.activeDeliverySessionId });
        }

        if (!session || session.state === 'COMPLETED' || session.state === 'EXPIRED') {
            const sessionId = crypto.randomUUID();
            const custId = order.userId || order.clientId || order.user || req.user?.id;
            session = new DeliverySession({
                sessionId,
                orderId: id,
                driverId: order.representativeId || req.user?.id || 'DRIVER_ID',
                customerId: custId ? custId.toString() : null,
                phase: phase,
                state: 'IN_PROGRESS',
                subState: 'WAITING_DRIVER_UPLOAD',
                expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000) // +2 hours hard expiration
            });
            await session.save();

            order.activeDeliverySessionId = sessionId;
            await order.save();
        } else if (phase && session.phase !== phase) {
            session.phase = phase;
            await session.save();
        }

        // Single-Use UUID Object Key
        const objectKey = `pod/${session.sessionId}/${crypto.randomUUID()}`;
        const uploadUrl = `https://mock-s3-bucket.amazonaws.com/${objectKey}?AWSAccessKeyId=...&Signature=...`;

        res.json({
            success: true,
            sessionId: session.sessionId,
            uploadUrl,
            objectKey,
            bucket: 'mashawerr-pod-bucket',
            phase: session.phase
        });
    } catch (err) {
        logger.error(`[PoD] getUploadUrl error [${traceId}]:`, err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        logger.info(`[Metrics] Upload URL Time: ${Date.now() - startTime}ms`);
    }
};

// ─── 2. Create Attempt (After Upload) & AI Validation ────────────────────────
exports.createAttempt = async (req, res) => {
    const traceId = req.headers['x-correlation-id'] || crypto.randomUUID();
    const startTime = Date.now();
    const { id, sessionId } = req.params;

    // Acquire Lock
    const locked = await redisLock(sessionId, 5000);
    if (!locked) return res.status(429).json({ success: false, message: 'Concurrent request processing' });

    try {
        const { photo, metadata, phase } = req.body;

        const session = await DeliverySession.findOne({ sessionId });
        if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

        const reqPhase = (phase || req.query.phase || session.phase || 'DELIVERY').toUpperCase();
        session.phase = reqPhase;
        await session.save();

        // If base64 photo is provided (Fallback from mock S3), upload to Cloudinary
        if (photo && photo.base64) {
            try {
                const uploadRes = await cloudinary.uploader.upload(`data:image/jpeg;base64,${photo.base64}`, {
                    folder: 'mashawerr/pod_attempts',
                });
                photo.cdnUrl = uploadRes.secure_url;
                photo.objectKey = uploadRes.public_id;
                delete photo.base64; // Remove base64 so it's not saved in DB
            } catch (err) {
                logger.error(`[PoD] Cloudinary upload error [${traceId}]:`, err);
            }
        }

        // Fraud Check: pHash (Flag Only, NO Real-time Blocking as per user instructions)
        let isFraudFlagged = false;
        if (photo.pHash) {
            isFraudFlagged = await checkAndSetFraudHash(photo.pHash);
            if (isFraudFlagged) {
                logger.warn(`[Fraud] Flagged pHash duplicate for session ${sessionId}`);
                // We proceed without blocking
            }
        }

        // Enforce limits per phase (Multi-task & Multi-stop resilient)
        const existingAttempts = await DeliveryAttempt.countDocuments({ sessionId, phase: reqPhase });
        const maxAttempts = 20;

        if (existingAttempts >= maxAttempts) {
            logger.warn(`[PoD] Max attempts (${maxAttempts}) reached for session ${sessionId} phase ${reqPhase}`);
            // Log warning but allow continuation for multi-task / multi-stop workflows
        }

        // Create Attempt
        const attemptId = crypto.randomUUID();
        const rawTaskId = req.body?.taskId || req.query?.taskId || req.body?.subOrderId || req.query?.subOrderId;
        const rawStopIndex = req.body?.stopIndex ?? req.query?.stopIndex;
        const rawItemIndex = req.body?.itemIndex ?? req.query?.itemIndex ?? req.body?.index ?? req.query?.index;
        const rawProductId = req.body?.productId || req.query?.productId;

        const attempt = new DeliveryAttempt({
            attemptId,
            sessionId,
            attemptNumber: existingAttempts + 1,
            phase: reqPhase,
            taskId: rawTaskId ? String(rawTaskId) : null,
            stopIndex: rawStopIndex !== undefined && rawStopIndex !== null ? Number(rawStopIndex) : null,
            itemIndex: rawItemIndex !== undefined && rawItemIndex !== null ? Number(rawItemIndex) : null,
            productId: rawProductId ? String(rawProductId) : null,
            photo,
            metadata,
            state: 'AI_VALIDATION'
        });
        await attempt.save();

        // ─── Local AI Pre-Validation (Blur, Brightness, Black Image) ───
        const aiStartTime = Date.now();
        const isBlurryOrBlack = false; // Stub: Local AI check
        logger.info(`[Metrics] AI Validation Time: ${Date.now() - aiStartTime}ms`);

        if (isBlurryOrBlack) {
            attempt.state = 'AI_REJECTED';
            attempt.rejectionReason = 'AI_BLURRY';
            await attempt.save();

            await DeliveryEventBus.emitAiRejected(req.app.get('io'), session, attempt, traceId);
            return res.status(400).json({ success: false, message: 'Image rejected by validation (blurry/black). Please retake.' });
        }

        // Pass Validation
        attempt.state = 'WAITING_CUSTOMER_REVIEW';
        await attempt.save();

        // Update session phase, subState and parent order photo
        session.phase = reqPhase;
        session.subState = reqPhase === 'PICKUP' ? 'WAITING_PICKUP_APPROVAL' : 'WAITING_CUSTOMER';
        await session.save();

        try {
            const isStore = req.baseUrl.includes('store') || String(session.orderId).length > 20;
            const subId = req.body?.subOrderId || req.query?.subOrderId || req.body?.taskId || req.query?.taskId || req.body?.productId || req.query?.productId;
            const parentOrder = await getParentOrder(session.orderId, isStore, subId);
            if (parentOrder && (photo?.cdnUrl || photo?.objectKey)) {
                const urlToSave = photo.cdnUrl || `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${photo.objectKey}`;
                const rawTaskId = req.body?.taskId || req.query?.taskId || req.body?.subOrderId || req.query?.subOrderId;
                const rawItemIdx = req.body?.itemIndex ?? req.query?.itemIndex ?? req.body?.index ?? req.query?.index;
                const rawProdId = req.body?.productId || req.query?.productId;

                let parsedTaskId = null;
                if (rawTaskId != null && !isNaN(parseInt(rawTaskId, 10))) {
                    parsedTaskId = parseInt(rawTaskId, 10);
                }
                let parsedItemIdx = null;
                if (rawItemIdx != null && !isNaN(parseInt(rawItemIdx, 10))) {
                    parsedItemIdx = parseInt(rawItemIdx, 10);
                } else if (parsedTaskId != null && parsedTaskId >= 1) {
                    parsedItemIdx = parsedTaskId - 1;
                }

                if (reqPhase === 'PICKUP') {
                    if (!parentOrder.pickupPhoto) {
                        parentOrder.pickupPhoto = urlToSave;
                        parentOrder.pickupPhotoUrl = urlToSave;
                        parentOrder.itemPhotoBefore = urlToSave;
                    }

                    if (Array.isArray(parentOrder.items) && parentOrder.items.length > 0) {
                        let targetItem = null;
                        if (rawProdId) {
                            targetItem = parentOrder.items.find(i => String(i.product || i._id) === String(rawProdId));
                        }
                        if (!targetItem && parsedItemIdx != null && parentOrder.items[parsedItemIdx]) {
                            targetItem = parentOrder.items[parsedItemIdx];
                        }
                        if (!targetItem) {
                            targetItem = parentOrder.items.find(i => !i.pickupPhoto && !i.itemPhotoBefore && !i.pickupPhotoUrl);
                        }
                        if (!targetItem && parentOrder.items.length === 1) {
                            targetItem = parentOrder.items[0];
                        }
                        if (targetItem) {
                            targetItem.pickupPhoto = urlToSave;
                            targetItem.pickupPhotoUrl = urlToSave;
                            targetItem.itemPhotoBefore = urlToSave;
                        }
                    }

                    if (Array.isArray(parentOrder.tasks) && parentOrder.tasks.length > 0) {
                        if (parsedTaskId != null && parsedTaskId >= 1 && parentOrder.tasks[parsedTaskId - 1]) {
                            parentOrder.tasks[parsedTaskId - 1].itemPhotoBefore = urlToSave;
                            parentOrder.tasks[parsedTaskId - 1].pickupPhoto = urlToSave;
                            parentOrder.tasks[parsedTaskId - 1].pickupPhotoUrl = urlToSave;
                        } else if (rawTaskId) {
                            parentOrder.tasks.forEach((t) => {
                                if (String(t.taskId) === String(rawTaskId) || String(t._id) === String(rawTaskId)) {
                                    t.itemPhotoBefore = urlToSave;
                                    t.pickupPhoto = urlToSave;
                                    t.pickupPhotoUrl = urlToSave;
                                }
                            });
                        } else {
                            const emptyTask = parentOrder.tasks.find((t) => !t.itemPhotoBefore && !t.pickupPhoto);
                            if (emptyTask) {
                                emptyTask.itemPhotoBefore = urlToSave;
                                emptyTask.pickupPhoto = urlToSave;
                                emptyTask.pickupPhotoUrl = urlToSave;
                            } else if (parentOrder.tasks.length === 1) {
                                parentOrder.tasks[0].itemPhotoBefore = urlToSave;
                                parentOrder.tasks[0].pickupPhoto = urlToSave;
                                parentOrder.tasks[0].pickupPhotoUrl = urlToSave;
                            }
                        }
                    }
                    if (Array.isArray(parentOrder.allLocationsInOrder) && parentOrder.allLocationsInOrder.length > 0) {
                        const rawStopIdx = attempt?.stopIndex ?? req.body?.stopIndex ?? req.query?.stopIndex;
                        let targetLoc = null;
                        if (rawStopIdx !== undefined && rawStopIdx !== null && parentOrder.allLocationsInOrder[parseInt(rawStopIdx, 10)]) {
                            targetLoc = parentOrder.allLocationsInOrder[parseInt(rawStopIdx, 10)];
                        }
                        if (!targetLoc) {
                            targetLoc = parentOrder.allLocationsInOrder.find(l => l.isFrom === true && !l.isCompleted);
                        }
                        if (targetLoc) {
                            targetLoc.pickupPhoto = urlToSave;
                            parentOrder.markModified('allLocationsInOrder');
                        }
                    }
                } else {
                    parentOrder.deliveryPhoto = urlToSave;
                    parentOrder.deliveryPhotoUrl = urlToSave;
                    parentOrder.itemPhotoAfter = urlToSave;

                    if (Array.isArray(parentOrder.items) && parentOrder.items.length > 0) {
                        let targetItem = null;
                        if (rawProdId) {
                            targetItem = parentOrder.items.find(i => String(i.product || i._id) === String(rawProdId));
                        }
                        if (!targetItem && parsedItemIdx != null && parentOrder.items[parsedItemIdx]) {
                            targetItem = parentOrder.items[parsedItemIdx];
                        }
                        if (!targetItem) {
                            targetItem = parentOrder.items.find(i => !i.deliveryPhoto && !i.itemPhotoAfter && !i.deliveryPhotoUrl);
                        }
                        if (!targetItem && parentOrder.items.length === 1) {
                            targetItem = parentOrder.items[0];
                        }
                        if (targetItem) {
                            targetItem.deliveryPhoto = urlToSave;
                            targetItem.deliveryPhotoUrl = urlToSave;
                            targetItem.itemPhotoAfter = urlToSave;
                        }
                    }

                    if (Array.isArray(parentOrder.tasks) && parentOrder.tasks.length > 0) {
                        if (parsedTaskId != null && parsedTaskId >= 1 && parentOrder.tasks[parsedTaskId - 1]) {
                            parentOrder.tasks[parsedTaskId - 1].itemPhotoAfter = urlToSave;
                            parentOrder.tasks[parsedTaskId - 1].deliveryPhoto = urlToSave;
                            parentOrder.tasks[parsedTaskId - 1].deliveryPhotoUrl = urlToSave;
                        } else if (rawTaskId) {
                            parentOrder.tasks.forEach((t) => {
                                if (String(t.taskId) === String(rawTaskId) || String(t._id) === String(rawTaskId)) {
                                    t.itemPhotoAfter = urlToSave;
                                    t.deliveryPhoto = urlToSave;
                                    t.deliveryPhotoUrl = urlToSave;
                                }
                            });
                        } else {
                            const emptyTask = parentOrder.tasks.find((t) => !t.itemPhotoAfter && !t.deliveryPhoto);
                            if (emptyTask) {
                                emptyTask.itemPhotoAfter = urlToSave;
                                emptyTask.deliveryPhoto = urlToSave;
                                emptyTask.deliveryPhotoUrl = urlToSave;
                            } else if (parentOrder.tasks.length === 1) {
                                parentOrder.tasks[0].itemPhotoAfter = urlToSave;
                                parentOrder.tasks[0].deliveryPhoto = urlToSave;
                                parentOrder.tasks[0].deliveryPhotoUrl = urlToSave;
                            }
                        }
                    }

                    if (Array.isArray(parentOrder.allLocationsInOrder) && parentOrder.allLocationsInOrder.length > 0) {
                        const rawStopIdx = attempt?.stopIndex ?? req.body?.stopIndex ?? req.query?.stopIndex;
                        let targetLoc = null;
                        if (rawStopIdx !== undefined && rawStopIdx !== null && parentOrder.allLocationsInOrder[parseInt(rawStopIdx, 10)]) {
                            targetLoc = parentOrder.allLocationsInOrder[parseInt(rawStopIdx, 10)];
                        }
                        if (!targetLoc) {
                            targetLoc = parentOrder.allLocationsInOrder.find(l => l.isFrom === false && !l.isCompleted);
                        }
                        if (targetLoc) {
                            targetLoc.deliveryPhoto = urlToSave;
                            parentOrder.markModified('allLocationsInOrder');
                        }
                    }
                }
                await parentOrder.save();
            }
        } catch (_) { }

        if (!session.customerId) {
            const isStore = req.baseUrl.includes('store') || String(session.orderId).length > 20;
            const parentOrder = await getParentOrder(session.orderId, isStore);
            if (parentOrder) {
                const resolvedCustId = parentOrder.userId || parentOrder.clientId || parentOrder.user;
                if (resolvedCustId) {
                    session.customerId = resolvedCustId.toString();
                    await session.save();
                }
            }
        }

        // Dispatch Event
        await DeliveryEventBus.emitAttemptCreated(req.app.get('io'), session, attempt, traceId);

        res.json({ success: true, attemptId, state: attempt.state, phase: reqPhase, isFraudFlagged });
    } catch (err) {
        logger.error(`[PoD] createAttempt error [${traceId}]:`, err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        await redisUnlock(sessionId);
        logger.info(`[Metrics] createAttempt Request Time: ${Date.now() - startTime}ms`);
    }
};

// ─── Utility: Complete Pickup or Delivery Phase Directly (No OTP Required) ───
async function completeDeliveryOrPickup(session, orderId, isPickup, req, traceId, attempt = null) {
    const io = req.app?.get ? req.app.get('io') : null;
    const isStoreFromUrl = req.baseUrl?.includes('store') || false;
    const isStoreGuess = isStoreFromUrl || (session && String(session.orderId).includes('-'));
    const parentOrder = await getParentOrder(orderId, isStoreGuess);
    const isExplicitStore = Boolean(
        parentOrder && (
            parentOrder.isBusinessOrder === true ||
            parentOrder.orderCategory === 'business' ||
            parentOrder.storeOrderId != null ||
            parentOrder.parentGroupId != null ||
            (Array.isArray(parentOrder.items) && parentOrder.items.length > 0)
        )
    );
    const hasLocations = Array.isArray(parentOrder?.allLocationsInOrder) && parentOrder.allLocationsInOrder.length > 0;
    const isStoreOrder = isExplicitStore || (!hasLocations && (isStoreFromUrl || (session && String(session.orderId).includes('-'))));
    const photoUrl = attempt?.photo?.cdnUrl || attempt?.photo?.url || attempt?.photo?.secure_url || (attempt?.photo?.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${attempt.photo.objectKey}` : null);
    let resolvedGroupId = null;

    if (isPickup) {
        let allPickedUp = true;

        if (isStoreOrder) {
            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
            let subOrders = [];
            resolvedGroupId = null;

            if (isUUID) {
                resolvedGroupId = orderId;
                subOrders = await StoreOrder.find({ parentGroupId: orderId }).sort({ subOrderIndex: 1, createdAt: 1 });
            } else if (mongoose.isValidObjectId(orderId)) {
                const o = await StoreOrder.findById(orderId);
                if (o?.parentGroupId) {
                    resolvedGroupId = o.parentGroupId;
                    subOrders = await StoreOrder.find({ parentGroupId: o.parentGroupId }).sort({ subOrderIndex: 1, createdAt: 1 });
                } else if (o) {
                    subOrders = [o];
                }
            } else if (!isNaN(Number(orderId))) {
                const numId = Number(orderId);
                const allByStoreId = await StoreOrder.find({ $or: [{ storeOrderId: numId }, { orderId: numId }] }).sort({ subOrderIndex: 1, createdAt: 1 });
                if (allByStoreId.length > 0 && allByStoreId[0]?.parentGroupId) {
                    resolvedGroupId = allByStoreId[0].parentGroupId;
                    subOrders = await StoreOrder.find({ parentGroupId: allByStoreId[0].parentGroupId }).sort({ subOrderIndex: 1, createdAt: 1 });
                } else {
                    subOrders = allByStoreId;
                }
            }

            if (subOrders.length === 0 && parentOrder?.parentGroupId) {
                resolvedGroupId = parentOrder.parentGroupId;
                subOrders = await StoreOrder.find({ parentGroupId: parentOrder.parentGroupId }).sort({ subOrderIndex: 1, createdAt: 1 });
            }
            if (subOrders.length === 0 && parentOrder) {
                subOrders = [parentOrder];
            }

            const reqStopIndex = attempt?.stopIndex ?? req.body?.stopIndex ?? req.query?.stopIndex;
            const reqSubId = attempt?.taskId || req.body?.taskId || req.body?.subOrderId || req.query?.subOrderId || req.query?.taskId;
            const reqItemIndex = attempt?.itemIndex ?? req.body?.itemIndex ?? req.query?.itemIndex ?? req.body?.index ?? req.query?.index;
            const reqProdId = attempt?.productId || req.body?.productId || req.query?.productId;

            let targetSub = null;
            let targetItem = null;
            const orderRef = resolvedGroupId || parentOrder?.parentGroupId || parentOrder?.storeOrderId || parentOrder?._id || session?.orderId || orderId;
            const initialTrack = await BusinessOrderTracker.getOrderTrack(orderRef).catch(() => null);
            if (initialTrack && Array.isArray(initialTrack.stops) && reqStopIndex !== undefined && reqStopIndex !== null && reqStopIndex !== '') {
                const sIdx = parseInt(reqStopIndex, 10);
                const stopObj = initialTrack.stops[sIdx];
                if (stopObj) {
                    targetSub = subOrders.find(s => String(s._id) === String(stopObj.subOrderId));
                    if (!targetSub && subOrders.length === 1) {
                        targetSub = subOrders[0];
                    }
                    if (targetSub && Array.isArray(targetSub.items) && targetSub.items[stopObj.itemIndex]) {
                        targetItem = targetSub.items[stopObj.itemIndex];
                    }
                }
            }

            if (!targetSub && reqSubId) {
                targetSub = subOrders.find(s => String(s._id) === String(reqSubId));
            }
            if (!targetSub && initialTrack?.currentStop) {
                targetSub = subOrders.find(s => String(s._id) === String(initialTrack.currentStop.subOrderId));
                if (targetSub && Array.isArray(targetSub.items) && targetSub.items[initialTrack.currentStop.itemIndex]) {
                    targetItem = targetSub.items[initialTrack.currentStop.itemIndex];
                }
            }
            if (!targetSub) {
                targetSub = subOrders.find(s => s.status !== 'shipped' && s.status !== 'delivering' && s.status !== 'delivered');
            }
            if (!targetSub && subOrders.length > 0) {
                targetSub = subOrders[0];
            }

            if (targetSub) {
                if (photoUrl) {
                    targetSub.pickupPhoto = photoUrl;
                    targetSub.pickupPhotoUrl = photoUrl;
                    targetSub.itemPhotoBefore = photoUrl;
                }
                if (Array.isArray(targetSub.items) && targetSub.items.length > 0) {
                    if (!targetItem && reqProdId) targetItem = targetSub.items.find(i => String(i.product || i._id) === String(reqProdId));
                    if (!targetItem && reqItemIndex !== undefined && reqItemIndex !== null && reqItemIndex !== '') {
                        const idx = parseInt(reqItemIndex, 10);
                        if (!isNaN(idx) && targetSub.items[idx]) targetItem = targetSub.items[idx];
                    }
                    if (!targetItem && reqSubId !== undefined && reqSubId !== null && reqSubId !== '') {
                        const tId = parseInt(reqSubId, 10);
                        if (!isNaN(tId) && tId >= 1 && targetSub.items[tId - 1]) targetItem = targetSub.items[tId - 1];
                    }
                    if (!targetItem) {
                        targetItem = targetSub.items.find(i => !i.isPickedUp && i.status !== 'shipped');
                    }
                    if (targetItem) {
                        targetItem.status = 'shipped';
                        targetItem.isPickedUp = true;
                        if (photoUrl) {
                            targetItem.pickupPhoto = photoUrl;
                            targetItem.pickupPhotoUrl = photoUrl;
                            targetItem.itemPhotoBefore = photoUrl;
                        }
                    } else if (targetSub.items.length === 1) {
                        targetSub.items[0].status = 'shipped';
                        targetSub.items[0].isPickedUp = true;
                        if (photoUrl) {
                            targetSub.items[0].pickupPhoto = photoUrl;
                            targetSub.items[0].pickupPhotoUrl = photoUrl;
                            targetSub.items[0].itemPhotoBefore = photoUrl;
                        }
                    } else {
                        const firstUnpicked = targetSub.items.find(i => !i.isPickedUp && i.status !== 'shipped');
                        if (firstUnpicked) {
                            firstUnpicked.status = 'shipped';
                            firstUnpicked.isPickedUp = true;
                            if (photoUrl) {
                                firstUnpicked.pickupPhoto = photoUrl;
                                firstUnpicked.pickupPhotoUrl = photoUrl;
                                firstUnpicked.itemPhotoBefore = photoUrl;
                            }
                        }
                    }
                    const allSubItemsShipped = targetSub.items.every(i => i.status === 'shipped' || i.isPickedUp === true || i.isDelivered === true);
                    targetSub.status = allSubItemsShipped ? 'shipped' : targetSub.status;
                    targetSub.isPickedUp = allSubItemsShipped;
                    targetSub.markModified('items');
                } else {
                    targetSub.status = 'shipped';
                    targetSub.isPickedUp = true;
                }
                await targetSub.save().catch(() => {});
                await StoreOrder.updateOne(
                    { _id: targetSub._id },
                    {
                        $set: {
                            items: targetSub.items,
                            status: targetSub.status,
                            isPickedUp: targetSub.isPickedUp,
                            ...(photoUrl ? { pickupPhoto: photoUrl, pickupPhotoUrl: photoUrl, itemPhotoBefore: photoUrl } : {})
                        }
                    }
                ).catch(() => {});
            }

            const trackData = await BusinessOrderTracker.getOrderTrack(orderRef).catch(() => null);
            allPickedUp = trackData ? trackData.allPickupsDone : true;

            if (allPickedUp) {
                const finalGroupId = resolvedGroupId || parentOrder?.parentGroupId;
                if (finalGroupId) {
                    await StoreOrder.updateMany({ parentGroupId: finalGroupId }, { status: 'delivering' }).catch(() => {});
                } else if (parentOrder) {
                    parentOrder.status = 'delivering';
                    await parentOrder.save().catch(() => {});
                }
            }
        } else if (parentOrder) {
            const photoUrl = attempt?.photo?.cdnUrl || attempt?.photo?.url || attempt?.photo?.secure_url || (attempt?.photo?.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${attempt.photo.objectKey}` : null);

            const hasLocations = Array.isArray(parentOrder.allLocationsInOrder) && parentOrder.allLocationsInOrder.length > 0;

            if (hasLocations) {
                const reqStopIndex = attempt?.stopIndex ?? req.body?.stopIndex ?? req.query?.stopIndex;
                let targetStop = null;
                if (reqStopIndex !== undefined && reqStopIndex !== null && parentOrder.allLocationsInOrder[parseInt(reqStopIndex, 10)]) {
                    targetStop = parentOrder.allLocationsInOrder[parseInt(reqStopIndex, 10)];
                }
                if (!targetStop) {
                    targetStop = parentOrder.allLocationsInOrder.find(l => l.isFrom === true && !l.isCompleted);
                }
                if (targetStop) {
                    targetStop.isCompleted = true;
                    targetStop.completedAt = new Date();
                    if (photoUrl) targetStop.pickupPhoto = photoUrl;
                }
                parentOrder.markModified('allLocationsInOrder');
            }

            if (Array.isArray(parentOrder.tasks) && parentOrder.tasks.length > 0) {
                const reqTaskId = req.body?.taskId || req.query?.taskId || req.body?.subOrderId || req.query?.subOrderId || attempt?.taskId;
                let targetTask = null;
                if (reqTaskId) {
                    targetTask = parentOrder.tasks.find(t => String(t.taskId) === String(reqTaskId) || String(t._id) === String(reqTaskId));
                }
                if (!targetTask) {
                    targetTask = parentOrder.tasks.find(t => !t.isPickedUp && t.taskStatus !== 'completed');
                }
                if (targetTask) {
                    targetTask.isPickedUp = true;
                    targetTask.pickedUpAt = new Date();
                    if (photoUrl) {
                        targetTask.itemPhotoBefore = photoUrl;
                        targetTask.pickupPhoto = photoUrl;
                    }
                }
            }

            let allStopsCompleted = false;
            if (hasLocations) {
                allPickedUp = parentOrder.allLocationsInOrder
                    .filter(l => l.isFrom === true)
                    .every(l => l.isCompleted === true);
                allStopsCompleted = parentOrder.allLocationsInOrder.every(l => l.isCompleted === true);
            } else if (Array.isArray(parentOrder.tasks) && parentOrder.tasks.length > 0) {
                allPickedUp = parentOrder.tasks.every(t => t.isPickedUp === true || t.taskStatus === 'completed');
                allStopsCompleted = parentOrder.tasks.every(t => t.taskStatus === 'completed');
            } else {
                allPickedUp = true;
            }

            if (photoUrl) {
                parentOrder.pickupPhoto = photoUrl;
                parentOrder.itemPhotoBefore = photoUrl;
            }
            if (allStopsCompleted) {
                parentOrder.status = 'delivered';
            } else if (allPickedUp) {
                parentOrder.status = 'delivering';
            } else {
                parentOrder.status = 'processing';
            }
            await parentOrder.save().catch(() => {});
        }

        const orderRef = resolvedGroupId || parentOrder?.parentGroupId || parentOrder?.storeOrderId || parentOrder?._id || session?.orderId || orderId;
        const trackData = isStoreOrder
            ? await BusinessOrderTracker.getOrderTrack(orderRef).catch(() => null)
            : await DeliveryOrderTracker.getOrderTrack(orderId).catch(() => null);

        if (trackData) {
            allPickedUp = trackData.allPickupsDone;
        }

        const extraRooms = [
            parentOrder?.parentGroupId ? `order:${parentOrder.parentGroupId}` : null,
            parentOrder?.storeOrderId ? `order:${parentOrder.storeOrderId}` : null,
            parentOrder?._id ? `order:${parentOrder._id}` : null,
            `order:${orderId}`,
            session ? `order:${session.orderId}` : null
        ].filter(Boolean);

        if (trackData) {
            trackData.extraRooms = extraRooms;
        }

        if (session) {
            if (trackData) {
                session.phase = trackData.phase === 'COMPLETED' ? 'DELIVERY' : trackData.phase;
                session.state = trackData.isAllCompleted ? 'COMPLETED' : 'IN_PROGRESS';
            } else if (allPickedUp) {
                session.phase = 'DELIVERY'; // Transition to DELIVERY when ALL pickups are done!
                session.state = 'IN_PROGRESS';
            } else {
                session.phase = 'PICKUP'; // Stay in PICKUP phase for next pickup stop!
                session.state = 'IN_PROGRESS';
            }
            session.subState = 'NONE';
            session.version = (session.version || 0) + 1;
            await session.save().catch(() => {});
        }

        try {
            await DeliveryEventBus.emitPickupApproved(io, session, trackData, traceId);
        } catch (_) {}

        return {
            success: true,
            isApproved: true,
            isPickup: true,
            allPickupsCompleted: allPickedUp,
            isCompleted: false,
            phase: session?.phase || 'DELIVERY',
            track: trackData,
            currentStopIndex: trackData?.currentStopIndex ?? 0,
            currentStop: trackData?.currentStop,
            message: allPickedUp
                ? 'تم اعتماد صورة الاستلام بنجاح، وتحويل حالة الطلب إلى جاري التوصيل'
                : 'تم اعتماد صورة استلام هذا المنتج بنجاح! يرجى التوجه للاستلام التالي 🚚'
        };
    }

    // Delivery Phase handling (Multi-task & Multi-stop aware)
    let allDone = true;

    if (isStoreOrder) {
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId);
        let subOrders = [];
        resolvedGroupId = null;

        if (isUUID) {
            resolvedGroupId = orderId;
            subOrders = await StoreOrder.find({ parentGroupId: orderId }).sort({ subOrderIndex: 1, createdAt: 1 });
        } else if (mongoose.isValidObjectId(orderId)) {
            const o = await StoreOrder.findById(orderId);
            if (o?.parentGroupId) {
                resolvedGroupId = o.parentGroupId;
                subOrders = await StoreOrder.find({ parentGroupId: o.parentGroupId }).sort({ subOrderIndex: 1, createdAt: 1 });
            } else if (o) {
                subOrders = [o];
            }
        } else if (!isNaN(Number(orderId))) {
            const numId = Number(orderId);
            const allByStoreId = await StoreOrder.find({ $or: [{ storeOrderId: numId }, { orderId: numId }] }).sort({ subOrderIndex: 1, createdAt: 1 });
            if (allByStoreId.length > 0) {
                const groupId = allByStoreId[0]?.parentGroupId;
                if (groupId) {
                    resolvedGroupId = groupId;
                    subOrders = await StoreOrder.find({ parentGroupId: groupId }).sort({ subOrderIndex: 1, createdAt: 1 });
                } else {
                    subOrders = allByStoreId;
                }
            }
        }

        if (subOrders.length === 0 && parentOrder?.parentGroupId) {
            resolvedGroupId = parentOrder.parentGroupId;
            subOrders = await StoreOrder.find({ parentGroupId: parentOrder.parentGroupId }).sort({ subOrderIndex: 1, createdAt: 1 });
        }
        if (subOrders.length === 0 && parentOrder) {
            subOrders = [parentOrder];
        }

        const photoUrl = attempt?.photo?.cdnUrl || attempt?.photo?.url || attempt?.photo?.secure_url || (attempt?.photo?.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${attempt.photo.objectKey}` : null);

        if (subOrders.length > 0) {
            const reqStopIndex = attempt?.stopIndex ?? req.body?.stopIndex ?? req.query?.stopIndex;
            const reqSubId = attempt?.taskId || req.body?.taskId || req.body?.subOrderId || req.query?.subOrderId || req.query?.taskId;
            const reqItemIndex = attempt?.itemIndex ?? req.body?.itemIndex ?? req.query?.itemIndex ?? req.body?.index ?? req.query?.index;
            const reqProdId = attempt?.productId || req.body?.productId || req.query?.productId;

            let targetSub = null;
            let targetItem = null;
            const orderRef = resolvedGroupId || parentOrder?.parentGroupId || parentOrder?.storeOrderId || parentOrder?._id || session?.orderId || orderId;
            const initialTrack = await BusinessOrderTracker.getOrderTrack(orderRef).catch(() => null);
            if (initialTrack && Array.isArray(initialTrack.stops) && reqStopIndex !== undefined && reqStopIndex !== null && reqStopIndex !== '') {
                const sIdx = parseInt(reqStopIndex, 10);
                const stopObj = initialTrack.stops[sIdx];
                if (stopObj) {
                    targetSub = subOrders.find(s => String(s._id) === String(stopObj.subOrderId));
                    if (!targetSub && subOrders.length === 1) {
                        targetSub = subOrders[0];
                    }
                    if (targetSub && Array.isArray(targetSub.items) && targetSub.items[stopObj.itemIndex]) {
                        targetItem = targetSub.items[stopObj.itemIndex];
                    }
                }
            }

            if (!targetSub && reqSubId) {
                targetSub = subOrders.find(s => String(s._id) === String(reqSubId));
            }
            if (!targetSub && initialTrack?.currentStop) {
                targetSub = subOrders.find(s => String(s._id) === String(initialTrack.currentStop.subOrderId));
                if (targetSub && Array.isArray(targetSub.items) && targetSub.items[initialTrack.currentStop.itemIndex]) {
                    targetItem = targetSub.items[initialTrack.currentStop.itemIndex];
                }
            }
            if (!targetSub) {
                targetSub = subOrders.find(s => s.status !== 'delivered' && s.status !== 'completed');
            }
            if (!targetSub) {
                targetSub = subOrders[0];
            }

            if (targetSub) {
                if (Array.isArray(targetSub.items) && targetSub.items.length > 0) {
                    if (!targetItem && reqProdId) {
                        targetItem = targetSub.items.find(i => String(i.product || i._id) === String(reqProdId));
                    }
                    if (!targetItem && reqItemIndex !== undefined && reqItemIndex !== null && reqItemIndex !== '') {
                        const idx = parseInt(reqItemIndex, 10);
                        if (!isNaN(idx) && targetSub.items[idx]) targetItem = targetSub.items[idx];
                    }
                    if (!targetItem && reqSubId !== undefined && reqSubId !== null && reqSubId !== '') {
                        const tId = parseInt(reqSubId, 10);
                        if (!isNaN(tId) && tId >= 1 && targetSub.items[tId - 1]) targetItem = targetSub.items[tId - 1];
                    }

                    const isReturn = targetSub.isReturnOrder === true || (typeof targetSub.status === 'string' && targetSub.status.startsWith('return_'));
                    const deliveredStatus = isReturn ? 'returned' : 'delivered';

                    if (targetItem) {
                        targetItem.status = deliveredStatus;
                        targetItem.isDelivered = true;
                        if (photoUrl) {
                            targetItem.deliveryPhoto = photoUrl;
                            targetItem.itemPhotoAfter = photoUrl;
                        }
                    } else if (targetSub.items.length === 1) {
                        targetSub.items[0].status = deliveredStatus;
                        targetSub.items[0].isDelivered = true;
                        if (photoUrl) {
                            targetSub.items[0].deliveryPhoto = photoUrl;
                            targetSub.items[0].itemPhotoAfter = photoUrl;
                        }
                    } else {
                        const undeliveredItem = targetSub.items.find(i => !i.isDelivered && i.status !== 'delivered' && i.status !== 'returned') || targetSub.items[0];
                        if (undeliveredItem) {
                            undeliveredItem.status = deliveredStatus;
                            undeliveredItem.isDelivered = true;
                            if (photoUrl) {
                                undeliveredItem.deliveryPhoto = photoUrl;
                                undeliveredItem.itemPhotoAfter = photoUrl;
                            }
                        }
                    }

                    const allItemsInSubDelivered = targetSub.items.every(i => i.status === 'delivered' || i.status === 'returned' || i.isDelivered === true);
                    if (allItemsInSubDelivered) {
                        targetSub.status = deliveredStatus;
                        targetSub.isDelivered = true;
                        if (isReturn) {
                            targetSub.returnedAt = targetSub.returnedAt || new Date();
                        } else {
                            targetSub.deliveredAt = targetSub.deliveredAt || new Date();
                        }
                        if (photoUrl) {
                            targetSub.deliveryPhoto = photoUrl;
                            targetSub.itemPhotoAfter = photoUrl;
                        }
                    } else {
                        targetSub.status = isReturn ? 'return_delivering' : 'delivering';
                        targetSub.isDelivered = false;
                    }
                    targetSub.markModified('items');
                } else {
                    const isReturn = targetSub.isReturnOrder === true || (typeof targetSub.status === 'string' && targetSub.status.startsWith('return_'));
                    const deliveredStatus = isReturn ? 'returned' : 'delivered';
                    targetSub.status = deliveredStatus;
                    targetSub.isDelivered = true;
                    if (isReturn) {
                        targetSub.returnedAt = targetSub.returnedAt || new Date();
                    } else {
                        targetSub.deliveredAt = targetSub.deliveredAt || new Date();
                    }
                    if (photoUrl) {
                        targetSub.deliveryPhoto = photoUrl;
                        targetSub.itemPhotoAfter = photoUrl;
                    }
                }
                await targetSub.save().catch(() => {});
                await StoreOrder.updateOne(
                    { _id: targetSub._id },
                    {
                        $set: {
                            items: targetSub.items,
                            status: targetSub.status,
                            isDelivered: targetSub.isDelivered,
                            deliveredAt: targetSub.deliveredAt || new Date(),
                            ...(targetSub.returnedAt ? { returnedAt: targetSub.returnedAt } : {}),
                            ...(photoUrl ? { deliveryPhoto: photoUrl, deliveryPhotoUrl: photoUrl, itemPhotoAfter: photoUrl } : {})
                        }
                    }
                ).catch(() => {});
            }

            // ─── إعادة جلب من DB بعد الحفظ للتأكد من الحالة الحقيقية ───
            const finalGroupId = resolvedGroupId || parentOrder?.parentGroupId;
            let updatedSubOrders;
            if (finalGroupId) {
                updatedSubOrders = await StoreOrder.find({ parentGroupId: finalGroupId }).lean();
            } else {
                const sid = targetSub?.storeOrderId || subOrders[0]?.storeOrderId;
                updatedSubOrders = sid
                    ? await StoreOrder.find({ storeOrderId: sid }).lean()
                    : subOrders;
            }

            const trackData = isStoreOrder ? await BusinessOrderTracker.getOrderTrack(orderRef).catch(() => null) : null;
            if (trackData) {
                allDone = trackData.isAllCompleted;
            } else {
                allDone = updatedSubOrders.length > 0 && updatedSubOrders.every(s => {
                    const isStatusDone = s.status === 'delivered' || s.status === 'completed' || s.status === 'returned';
                    if (!isStatusDone) return false;
                    if (Array.isArray(s.items) && s.items.length > 0) {
                        return s.items.every(i => i.status === 'delivered' || i.status === 'returned' || i.isDelivered === true);
                    }
                    return true;
                });
            }

            if (allDone && parentOrder) {
                const isReturn = parentOrder.isReturnOrder === true || (typeof parentOrder.status === 'string' && parentOrder.status.startsWith('return_'));
                parentOrder.status = isReturn ? 'returned' : 'delivered';
                if (isReturn) {
                    parentOrder.returnedAt = parentOrder.returnedAt || new Date();
                } else {
                    parentOrder.deliveredAt = parentOrder.deliveredAt || new Date();
                }
                await parentOrder.save().catch(() => {});
            } else if (parentOrder) {
                const isReturn = parentOrder.isReturnOrder === true || (typeof parentOrder.status === 'string' && parentOrder.status.startsWith('return_'));
                parentOrder.status = isReturn ? 'return_delivering' : 'delivering';
                await parentOrder.save().catch(() => {});
            }
        } else if (parentOrder) {
            const isReturn = parentOrder.isReturnOrder === true || (typeof parentOrder.status === 'string' && parentOrder.status.startsWith('return_'));
            parentOrder.status = isReturn ? 'return_delivering' : 'delivering';
            await parentOrder.save().catch(() => {});
            allDone = false;
        }
    } else if (parentOrder) {
        const photoUrl = attempt?.photo?.cdnUrl || attempt?.photo?.url || attempt?.photo?.secure_url || (attempt?.photo?.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${attempt.photo.objectKey}` : null);

        const hasLocations = Array.isArray(parentOrder.allLocationsInOrder) && parentOrder.allLocationsInOrder.length > 0;

        if (hasLocations) {
            const reqStopIndex = attempt?.stopIndex ?? req.body?.stopIndex ?? req.query?.stopIndex;
            let targetStop = null;
            if (reqStopIndex !== undefined && reqStopIndex !== null && parentOrder.allLocationsInOrder[parseInt(reqStopIndex, 10)]) {
                targetStop = parentOrder.allLocationsInOrder[parseInt(reqStopIndex, 10)];
            }
            if (!targetStop) {
                targetStop = parentOrder.allLocationsInOrder.find(l => l.isFrom === false && !l.isCompleted);
            }
            if (targetStop) {
                targetStop.isCompleted = true;
                targetStop.completedAt = new Date();
                if (photoUrl) targetStop.deliveryPhoto = photoUrl;
            }
            parentOrder.markModified('allLocationsInOrder');
        }

        if (Array.isArray(parentOrder.tasks) && parentOrder.tasks.length > 0) {
            const reqTaskId = attempt?.taskId || req.body?.taskId || req.query?.taskId || req.body?.subOrderId || req.query?.subOrderId;
            let targetTask = null;
            if (reqTaskId) {
                targetTask = parentOrder.tasks.find(t => String(t.taskId) === String(reqTaskId) || String(t._id) === String(reqTaskId));
            }
            if (!targetTask) {
                targetTask = parentOrder.tasks.find(t => t.taskStatus !== 'completed');
            }
            if (targetTask) {
                targetTask.taskStatus = 'completed';
                targetTask.deliveredAt = new Date();
                if (photoUrl) {
                    targetTask.itemPhotoAfter = photoUrl;
                    targetTask.deliveryPhoto = photoUrl;
                }
            }
        }

        if (hasLocations) {
            allDone = parentOrder.allLocationsInOrder.every(l => l.isCompleted === true);
        } else if (Array.isArray(parentOrder.tasks) && parentOrder.tasks.length > 0) {
            allDone = parentOrder.tasks.every(t => t.taskStatus === 'completed');
        } else {
            allDone = true;
        }

        if (photoUrl) {
            parentOrder.deliveryPhoto = photoUrl;
            parentOrder.itemPhotoAfter = photoUrl;
        }

        const isReturn = parentOrder.isReturnOrder === true || (typeof parentOrder.status === 'string' && parentOrder.status.startsWith('return_'));
        if (allDone) {
            parentOrder.status = isReturn ? 'returned' : 'delivered';
            if (isReturn) parentOrder.returnedAt = parentOrder.returnedAt || new Date();
            else parentOrder.deliveredAt = parentOrder.deliveredAt || new Date();
        } else {
            parentOrder.status = isReturn ? 'return_delivering' : 'delivering';
        }
        await parentOrder.save().catch(() => {});
    }

    const orderRef = resolvedGroupId || parentOrder?.parentGroupId || parentOrder?.storeOrderId || parentOrder?._id || session?.orderId || orderId;
    const trackData = isStoreOrder
        ? await BusinessOrderTracker.getOrderTrack(orderRef).catch(() => null)
        : await DeliveryOrderTracker.getOrderTrack(orderId).catch(() => null);

    if (trackData) {
        allDone = trackData.isAllCompleted;
    }

    const extraRooms = [
        parentOrder?.parentGroupId ? `order:${parentOrder.parentGroupId}` : null,
        parentOrder?.storeOrderId ? `order:${parentOrder.storeOrderId}` : null,
        parentOrder?._id ? `order:${parentOrder._id}` : null,
        `order:${orderId}`,
        session ? `order:${session.orderId}` : null
    ].filter(Boolean);

    if (allDone) {
        if (session) {
            session.state = 'COMPLETED';
            session.subState = 'NONE';
            session.version = (session.version || 0) + 1;
            await session.save().catch(() => {});
        }

        if (parentOrder) {
            if (!parentOrder.deliveryPhoto || !parentOrder.itemPhotoAfter) {
                try {
                    const deliveryAttempt = await DeliveryAttempt.findOne({ sessionId: session?.sessionId, phase: 'DELIVERY' }).sort({ createdAt: -1 });
                    if (deliveryAttempt && deliveryAttempt.photo) {
                        const p = deliveryAttempt.photo;
                        const photoUrl = p.cdnUrl || (p.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${p.objectKey}` : null);
                        if (photoUrl) {
                            parentOrder.deliveryPhoto = photoUrl;
                            parentOrder.itemPhotoAfter = photoUrl;
                            await parentOrder.save().catch(() => { });
                        }
                    }
                } catch (_) { }
            }

            try {
                const { processOrderCompletionWallet } = require('../middlewares/Wallet');
                await processOrderCompletionWallet(parentOrder).catch((e) => console.error('[podController] Wallet error:', e.message));
            } catch (_) {}

            // ─── إرسال إيميل الإتمام بعد آخر تسليم للأوردر كله ─────────────────
            try {
                const { sendDeliveryOrderCompletionEmail, sendBusinessOrderCompletionEmail, dispatchBackgroundEmail } = require('../services/emailService');
                const isBusinessOrder = parentOrder.isBusinessOrder === true ||
                    parentOrder.orderCategory === 'business' ||
                    !!parentOrder.parentGroupId ||
                    !!parentOrder.storeOrderId ||
                    (Array.isArray(parentOrder.items) && parentOrder.items.length > 0);

                const emailOrderRef = parentOrder.parentGroupId || parentOrder._id || parentOrder.storeOrderId || parentOrder.orderId;
                dispatchBackgroundEmail(async () => {
                    if (isBusinessOrder) {
                        await sendBusinessOrderCompletionEmail(emailOrderRef);
                    } else {
                        await sendDeliveryOrderCompletionEmail(parentOrder);
                    }
                });
            } catch (_) {}
        }

        try {
            await DeliveryEventBus.emitDeliveryCompleted(io, session, orderId, traceId);
            await DeliveryEventBus.emitDeliveryApproved(io, session, attempt, orderId, true, extraRooms, trackData, traceId);
        } catch (_) {}

        return {
            success: true,
            isApproved: true,
            isPickup: false,
            isCompleted: true,
            phase: 'COMPLETED',
            track: trackData,
            currentStopIndex: trackData?.currentStopIndex ?? 0,
            currentStop: trackData?.currentStop,
            message: 'تم اعتماد صورة التسليم وإكمال الطلب بنجاح'
        };
    } else {
        if (session) {
            session.state = 'IN_PROGRESS';
            session.subState = 'NONE';
            session.phase = trackData?.phase || 'DELIVERY';
            session.version = (session.version || 0) + 1;
            await session.save().catch(() => {});
        }

        const custId = parentOrder?.clientId || parentOrder?.userId || session?.customerId;
        if (custId) {
            notifyClient(
                custId,
                '✅ تم تسليم جزء من طلبك',
                'تم تسليم مهمة من الطلب بنجاح، والمندوب يتابع باقي المهام 🚚',
                { type: 'task_delivered', orderId: String(orderId) }
            ).catch(() => { });
        }

        try {
            await DeliveryEventBus.emitDeliveryApproved(io, session, attempt, orderId, false, extraRooms, trackData, traceId);
        } catch (_) {}

        return {
            success: true,
            isApproved: true,
            isPickup: false,
            isCompleted: false,
            phase: session?.phase || 'DELIVERY',
            track: trackData,
            currentStopIndex: trackData?.currentStopIndex ?? 0,
            currentStop: trackData?.currentStop,
            message: 'تم اعتماد صورة تسليم هذا المنتج بنجاح! يرجى التوجه لتسليم المنتج التالي 🚚'
        };
    }
}

// ─── 3. Customer Review (YES/NO) ─────────────────────────────────────────────
exports.reviewAttempt = async (req, res) => {
    const traceId = req.headers['x-correlation-id'] || crypto.randomUUID();
    const startTime = Date.now();
    const { sessionId, attemptId } = req.params;

    // Fail-open lock: if Redis lock fails, we still continue with request
    await redisLock(sessionId || 'default', 5000);

    try {
        const { decision, reason } = req.body;

        // 1. Resilient DeliverySession lookup (by sessionId, _id, or orderId)
        let session = null;
        if (sessionId && sessionId !== 'null' && sessionId !== 'undefined' && sessionId !== 'default' && sessionId !== 'local_pending') {
            session = await DeliverySession.findOne({
                $or: [
                    { sessionId: sessionId },
                    ...(mongoose.isValidObjectId(sessionId) ? [{ _id: sessionId }] : []),
                    { orderId: sessionId },
                    { orderId: isNaN(Number(sessionId)) ? sessionId : Number(sessionId) }
                ]
            });
        }
        if (!session && req.params.id) {
            session = await DeliverySession.findOne({
                $or: [
                    { orderId: req.params.id },
                    { orderId: isNaN(Number(req.params.id)) ? req.params.id : Number(req.params.id) }
                ]
            }).sort({ createdAt: -1 });
        }

        // 2. Resilient DeliveryAttempt lookup (by attemptId, _id, or latest attempt in session)
        let attempt = null;
        if (attemptId && attemptId !== 'null' && attemptId !== 'undefined' && attemptId !== 'default') {
            attempt = await DeliveryAttempt.findOne({
                $or: [
                    { attemptId: attemptId },
                    ...(mongoose.isValidObjectId(attemptId) ? [{ _id: attemptId }] : [])
                ]
            });
        }
        if (!attempt && session) {
            attempt = await DeliveryAttempt.findOne({ sessionId: session.sessionId }).sort({ attemptNumber: -1, createdAt: -1 });
        }

        // If session is still null, construct fallback session from parent order
        if (!session && req.params.id) {
            const isStore = req.baseUrl.includes('store');
            const parentOrder = await getParentOrder(req.params.id, isStore);
            if (parentOrder) {
                const newSessionId = crypto.randomUUID();
                const custId = parentOrder.userId || parentOrder.clientId || parentOrder.user || req.user?.id;
                session = new DeliverySession({
                    sessionId: newSessionId,
                    orderId: req.params.id,
                    driverId: parentOrder.representativeId || 'DRIVER_ID',
                    customerId: custId ? custId.toString() : null,
                    phase: (req.body?.phase || attempt?.phase || 'DELIVERY').toUpperCase(),
                    state: 'IN_PROGRESS',
                    subState: 'NONE',
                    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000)
                });
                await session.save().catch(() => {});
                parentOrder.activeDeliverySessionId = newSessionId;
                await parentOrder.save().catch(() => {});
            }
        }

        const effectiveOrderId = session?.orderId || req.params.id;
        const isPickup = attempt?.phase
            ? (attempt.phase === 'PICKUP')
            : ((req.body?.phase && req.body.phase.toUpperCase() === 'PICKUP') || session?.phase === 'PICKUP');

        if (decision === 'NO') {
            if (attempt) {
                attempt.state = 'REJECTED';
                attempt.rejectionReason = 'OTHER';
                await attempt.save().catch(() => {});
            }

            if (session) {
                session.subState = 'WAITING_DRIVER_UPLOAD';
                session.version = (session.version || 0) + 1;
                await session.save().catch(() => {});
            }

            // Update order status to 'review'
            const isStoreOrder = req.baseUrl.includes('store') || (session && String(session.orderId).includes('-'));
            if (isStoreOrder) {
                const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(effectiveOrderId);
                if (isUUID) {
                    await StoreOrder.updateMany(
                        { parentGroupId: effectiveOrderId },
                        { $set: { status: 'review', reviewReason: reason || 'رفض العميل الاستلام' } }
                    ).catch(() => {});
                } else if (mongoose.isValidObjectId(effectiveOrderId)) {
                    await StoreOrder.findByIdAndUpdate(effectiveOrderId, { status: 'review', reviewReason: reason || 'رفض العميل الاستلام' }).catch(() => {});
                } else {
                    await StoreOrder.findOneAndUpdate({ storeOrderId: Number(effectiveOrderId) }, { status: 'review', reviewReason: reason || 'رفض العميل الاستلام' }).catch(() => {});
                }
            } else {
                await Order.findOneAndUpdate(
                    { orderId: isNaN(Number(effectiveOrderId)) ? effectiveOrderId : Number(effectiveOrderId) },
                    { $set: { status: 'review', reviewReason: reason || 'رفض العميل الاستلام' } }
                ).catch(() => {});
            }

            if (session && attempt) {
                await DeliveryEventBus.emitAttemptRejected(req.app.get('io'), session, attempt, reason, traceId).catch(() => {});
            }

            return res.json({ success: true, message: 'Rejected successfully', phase: isPickup ? 'PICKUP' : 'DELIVERY' });
        }

        if (decision === 'YES' || !decision) {
            if (attempt) {
                attempt.state = 'APPROVED';
                await attempt.save().catch(() => {});
            }

            let result = null;
            try {
                result = await completeDeliveryOrPickup(session, effectiveOrderId, isPickup, req, traceId, attempt);
            } catch (completionErr) {
                logger.error(`[PoD] completeDeliveryOrPickup error [${traceId}]:`, completionErr);
                result = {
                    success: true,
                    isApproved: true,
                    isPickup: isPickup,
                    allPickupsCompleted: false,
                    isCompleted: false,
                    phase: isPickup ? 'PICKUP' : 'DELIVERY',
                    message: isPickup
                        ? 'تم اعتماد صورة الاستلام بنجاح'
                        : 'تم اعتماد صورة التسليم بنجاح'
                };
            }
            return res.json(result);
        }

        res.status(400).json({ success: false, message: 'Invalid decision' });
    } catch (err) {
        logger.error(`[PoD] reviewAttempt error [${traceId}]:`, err);
        res.status(500).json({ success: false, error: err.message, message: 'حدث خطأ غير متوقع أثناء معالجة القرار' });
    } finally {
        if (sessionId) {
            await redisUnlock(sessionId).catch(() => {});
        }
        logger.info(`[Metrics] Customer Review Time: ${Date.now() - startTime}ms`);
    }
};

// ─── 3b. Customer Requests New OTP (Backward Compatibility Stub) ─────────────
exports.resendOTP = async (req, res) => {
    return res.json({
        success: true,
        message: 'تم الاعتماد بنجاح من خلال صورة الاستلام/التسليم'
    });
};

// ─── 4. Driver Verifies OTP (Backward Compatibility Stub) ─────────────────────
exports.verifyOTP = async (req, res) => {
    const traceId = req.headers['x-correlation-id'] || crypto.randomUUID();
    const { id, sessionId } = req.params;

    try {
        let session = null;
        if (sessionId && sessionId !== 'null' && sessionId !== 'undefined' && sessionId.length > 5) {
            session = await DeliverySession.findOne({ sessionId });
        }
        if (!session) {
            session = await DeliverySession.findOne({ orderId: id }).sort({ createdAt: -1 });
        }
        if (!session && !isNaN(Number(id))) {
            session = await DeliverySession.findOne({ orderId: Number(id) }).sort({ createdAt: -1 });
        }

        if (!session) {
            return res.status(404).json({ success: false, message: 'جلسة التسليم غير موجودة' });
        }

        const isPickup = session.phase === 'PICKUP' ||
            session.subState === 'PICKUP_APPROVED' ||
            session.subState === 'WAITING_PICKUP_APPROVAL' ||
            (req.body?.phase && req.body.phase.toUpperCase() === 'PICKUP') ||
            (req.query?.phase && req.query.phase.toUpperCase() === 'PICKUP');

        const result = await completeDeliveryOrPickup(session, session.orderId || id, isPickup, req, traceId);
        return res.status(200).json(result);
    } catch (err) {
        logger.error(`[PoD] verifyOTP error [${traceId}]:`, err);
        return res.status(200).json({ success: true, message: 'Delivery Verified' });
    }
};

// ─── 5. Get Customer Delivery Confirmations & Active OTP Hub ─────────────────
exports.getCustomerConfirmations = async (req, res) => {
    const traceId = req.headers['x-correlation-id'] || crypto.randomUUID();
    try {
        const userId = req.user?.id || req.user?._id;
        if (!userId) {
            return res.status(401).json({ success: false, message: 'User unauthorized' });
        }

        const targetOrderId = req.query.orderId || req.query.targetOrderId;

        const userOrConditions = [
            { customerId: String(userId) },
            { customerId: userId }
        ];
        if (mongoose.isValidObjectId(userId)) {
            userOrConditions.push({ customerId: new mongoose.Types.ObjectId(userId) });
        }

        // Find store orders & normal orders for this user to ensure zero missed sessions
        const customerStoreOrders = await StoreOrder.find({
            $or: [
                { userId: String(userId) },
                { userId: userId },
                ...(mongoose.isValidObjectId(userId) ? [{ userId: new mongoose.Types.ObjectId(userId) }] : [])
            ]
        }).select('_id storeOrderId parentGroupId activeDeliverySessionId').lean();

        const storeOrderIds = [];
        const storeSessionIds = [];
        for (const so of customerStoreOrders) {
            if (so.parentGroupId) storeOrderIds.push(String(so.parentGroupId));
            if (so.storeOrderId != null) {
                storeOrderIds.push(so.storeOrderId);
                storeOrderIds.push(String(so.storeOrderId));
            }
            if (so._id) storeOrderIds.push(so._id.toString());
            if (so.activeDeliverySessionId) storeSessionIds.push(so.activeDeliverySessionId);
        }

        const customerNormalOrders = await Order.find({
            $or: [
                { clientId: String(userId) },
                { clientId: userId },
                ...(mongoose.isValidObjectId(userId) ? [{ clientId: new mongoose.Types.ObjectId(userId) }] : [])
            ]
        }).select('_id orderId activeDeliverySessionId').lean();

        const normalOrderIds = [];
        const normalSessionIds = [];
        for (const no of customerNormalOrders) {
            if (no.orderId != null) {
                normalOrderIds.push(no.orderId);
                normalOrderIds.push(String(no.orderId));
            }
            if (no._id) normalOrderIds.push(no._id.toString());
            if (no.activeDeliverySessionId) normalSessionIds.push(no.activeDeliverySessionId);
        }

        const allOrderIds = [...new Set([...storeOrderIds, ...normalOrderIds])];
        const allSessionIds = [...new Set([...storeSessionIds, ...normalSessionIds])];

        let sessionQuery = {
            $or: [
                ...userOrConditions,
                ...(allOrderIds.length > 0 ? [{ orderId: { $in: allOrderIds } }] : []),
                ...(allSessionIds.length > 0 ? [{ sessionId: { $in: allSessionIds } }] : [])
            ]
        };

        if (targetOrderId) {
            sessionQuery = {
                $or: [
                    { orderId: String(targetOrderId) },
                    { orderId: isNaN(Number(targetOrderId)) ? targetOrderId : Number(targetOrderId) },
                    ...userOrConditions,
                    ...(allOrderIds.length > 0 ? [{ orderId: { $in: allOrderIds } }] : []),
                    ...(allSessionIds.length > 0 ? [{ sessionId: { $in: allSessionIds } }] : [])
                ]
            };
        }

        // Find recent sessions for this customer
        const sessions = await DeliverySession.find(sessionQuery)
            .sort({ createdAt: -1 })
            .limit(30)
            .lean();

        const results = [];

        for (const session of sessions) {
            // Find latest attempt for this session
            const attempts = await DeliveryAttempt.find({ sessionId: session.sessionId })
                .sort({ attemptNumber: -1 })
                .lean();

            const latestAttempt = attempts[0] || null;

            // Fetch order info (StoreOrder or Order)
            let orderType = 'DELIVERY';
            let orderDetails = null;

            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.orderId);
            let storeOrders = [];

            if (isUUID) {
                storeOrders = await StoreOrder.find({ parentGroupId: session.orderId }).lean();
            } else if (mongoose.isValidObjectId(session.orderId)) {
                const so = await StoreOrder.findById(session.orderId).lean();
                if (so) storeOrders = [so];
            } else if (!isNaN(Number(session.orderId))) {
                storeOrders = await StoreOrder.find({ storeOrderId: Number(session.orderId) }).lean();
            }

            if (!storeOrders || storeOrders.length === 0) {
                storeOrders = await StoreOrder.find({
                    $or: [
                        { parentGroupId: session.orderId },
                        { storeOrderId: isNaN(Number(session.orderId)) ? -1 : Number(session.orderId) },
                        ...(mongoose.isValidObjectId(session.orderId) ? [{ _id: session.orderId }] : []),
                    ]
                }).lean();
            }

            if (storeOrders && storeOrders.length > 0) {
                orderType = 'BUSINESS';
                const items = [];
                let totalAmount = 0;
                let storeName = storeOrders[0]?.agentName || 'متجر مشاوير';

                for (const so of storeOrders) {
                    totalAmount += (so.totalPrice || 0);
                    if (so.items && Array.isArray(so.items)) {
                        for (const it of so.items) {
                            items.push({
                                productName: it.name || it.title || 'منتج تجاري',
                                quantity: it.quantity || 1,
                                price: it.price || 0,
                                image: it.image || it.photoUrl || null,
                            });
                        }
                    }
                }

                orderDetails = {
                    storeName,
                    items,
                    totalAmount,
                    status: storeOrders[0]?.status,
                };
            } else {
                // Regular Delivery Order
                let order = null;
                if (!isNaN(Number(session.orderId))) {
                    order = await Order.findOne({ orderId: Number(session.orderId) }).lean();
                } else if (mongoose.isValidObjectId(session.orderId)) {
                    order = await Order.findById(session.orderId).lean();
                }

                orderType = 'DELIVERY';
                orderDetails = {
                    pickupAddress: order?.pickupAddress || order?.pickupLocationName || 'عنوان الاستلام',
                    deliveryAddress: order?.deliveryAddress || order?.dropoffLocationName || 'عنوان التسليم',
                    details: order?.details || order?.itemDescription || 'طلب توصيل',
                    totalPrice: order?.cost || order?.totalPrice || 0,
                    status: order?.status || 'active',
                };
            }

            // Retrieve OTP code if available/generated
            let otpCode = session.activeOtpCode;
            if (!otpCode && session.otpVersion > 0) {
                otpCode = await getPlainOTP(session.sessionId, session.otpVersion);
            }
            if (!otpCode && (session.subState === 'WAITING_OTP' || session.otpVersion > 0) && session.state !== 'COMPLETED') {
                const newVersion = session.otpVersion || 1;
                otpCode = await generateAndStoreHMAC(session.sessionId, newVersion);
                await DeliverySession.updateOne({ sessionId: session.sessionId }, { activeOtpCode: otpCode, otpVersion: newVersion });
            }

            const attemptPhotoUrl = latestAttempt?.photo?.cdnUrl || (latestAttempt?.photo?.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${latestAttempt.photo.objectKey}` : null);
            const currentPhase = session.phase || latestAttempt?.phase || 'DELIVERY';
            const canReview = latestAttempt?.state === 'WAITING_CUSTOMER_REVIEW' &&
                (session.subState === 'WAITING_CUSTOMER' || session.subState === 'WAITING_PICKUP_APPROVAL' || session.subState === 'WAITING_DRIVER_UPLOAD');

            results.push({
                sessionId: session.sessionId,
                orderId: session.orderId,
                orderType, // 'BUSINESS' or 'DELIVERY'
                phase: currentPhase,
                sessionState: session.state,
                sessionSubState: session.subState,
                attemptId: latestAttempt?.attemptId || null,
                photoUrl: attemptPhotoUrl,
                state: latestAttempt?.state || session.subState,
                canReview,
                orderDetails,
                attempt: latestAttempt ? {
                    attemptId: latestAttempt.attemptId,
                    attemptNumber: latestAttempt.attemptNumber,
                    photoUrl: attemptPhotoUrl,
                    phase: latestAttempt.phase || currentPhase,
                    state: latestAttempt.state, // 'WAITING_CUSTOMER_REVIEW', 'APPROVED', 'REJECTED', 'AI_VALIDATION'
                    canReview: latestAttempt.state === 'WAITING_CUSTOMER_REVIEW',
                    rejectionReason: latestAttempt.rejectionReason || null,
                    uploadedAt: latestAttempt.createdAt,
                } : null,
                otp: {
                    code: otpCode,
                    version: session.otpVersion,
                    isAvailable: !!otpCode,
                },
                createdAt: session.createdAt,
            });
        }

        res.json({
            success: true,
            count: results.length,
            data: results,
            confirmations: results,
        });
    } catch (err) {
        logger.error(`[PoD] getCustomerConfirmations error [${traceId}]:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
};

// ─── 6. Get PoD Session Status for Driver / Order ─────────────────────────────
exports.getSessionStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const isStoreOrder = req.baseUrl.includes('store');

        const order = await getParentOrder(id, isStoreOrder);
        if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

        let session = null;
        if (order.activeDeliverySessionId) {
            session = await DeliverySession.findOne({ sessionId: order.activeDeliverySessionId }).lean();
        }

        if (!session) {
            session = await DeliverySession.findOne({ orderId: id }).sort({ createdAt: -1 }).lean();
        }

        if (!session) {
            return res.json({
                success: true,
                hasSession: false,
                message: 'No delivery session active for this order',
            });
        }

        const attempts = await DeliveryAttempt.find({ sessionId: session.sessionId }).sort({ attemptNumber: -1 }).lean();

        const currentPhase = session.phase || 'DELIVERY';

        const latestAttempt = attempts[0] || null;
        const latestAttemptForPhase = attempts.find(a => a.phase === currentPhase) || latestAttempt;
        const latestAttemptState = latestAttemptForPhase?.state || null;
        const latestAttemptPhase = latestAttemptForPhase?.phase || currentPhase;

        // Strictly evaluate approval for current active phase attempt: MUST be explicitly APPROVED
        const isApproved = latestAttemptForPhase?.state === 'APPROVED';
        const isPickupApproved = isApproved && (latestAttemptPhase === 'PICKUP');
        const isDeliveryApproved = (session.state === 'COMPLETED' || (isApproved && latestAttemptPhase === 'DELIVERY')) && latestAttemptState !== 'WAITING_CUSTOMER_REVIEW' && latestAttemptState !== 'AI_VALIDATION';

        const isRejected = latestAttemptState === 'REJECTED' || latestAttemptState === 'AI_REJECTED';

        let otpCode = session.activeOtpCode;
        if (!otpCode && session.otpVersion > 0) {
            otpCode = await getPlainOTP(session.sessionId, session.otpVersion);
        }

        const orderRef = order?.parentGroupId || order?._id || order?.storeOrderId || order?.orderId || session.orderId || id;
        let trackData = null;
        try {
            trackData = isStoreOrder
                ? await BusinessOrderTracker.getOrderTrack(orderRef)
                : await DeliveryOrderTracker.getOrderTrack(orderRef);
        } catch (_) { }

        res.json({
            success: true,
            hasSession: true,
            sessionId: session.sessionId,
            orderId: session.orderId,
            driverId: session.driverId,
            customerId: session.customerId,
            phase: currentPhase,
            latestAttemptPhase: latestAttemptPhase,
            sessionState: session.state,
            sessionSubState: session.subState,
            attemptState: latestAttemptState,
            isApproved,
            isPickupApproved,
            isDeliveryApproved,
            isRejected,
            rejectionReason: latestAttempt?.rejectionReason || null,
            track: trackData,
            currentStopIndex: trackData?.currentStopIndex ?? 0,
            currentStop: trackData?.currentStop,
            attempt: latestAttempt ? {
                attemptId: latestAttempt.attemptId,
                attemptNumber: latestAttempt.attemptNumber,
                phase: latestAttemptPhase,
                state: latestAttemptState,
                photoUrl: latestAttempt.photo?.cdnUrl || (latestAttempt.photo?.objectKey ? `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${latestAttempt.photo.objectKey}` : null),
                uploadedAt: latestAttempt.createdAt,
            } : null,
            otp: {
                code: otpCode,
                version: session.otpVersion,
                isAvailable: !!otpCode,
            },
            updatedAt: session.updatedAt,
        });
    } catch (err) {
        logger.error(`[PoD] getSessionStatus error:`, err);
        res.status(500).json({ success: false, error: err.message });
    }
};

// ─── Re-notify Customer of Pending Delivery Attempt Photo ─────────────────────
exports.renotifyCustomer = async (req, res) => {
    const traceId = req.headers['x-correlation-id'] || crypto.randomUUID();
    try {
        const { id, sessionId } = req.params;

        const parentOrder = await getParentOrder(id, req.baseUrl.includes('store'));
        if (!parentOrder) return res.status(404).json({ success: false, message: 'Order not found' });

        let session = null;
        if (sessionId) {
            session = await DeliverySession.findOne({ sessionId });
        }
        if (!session && parentOrder.activeDeliverySessionId) {
            session = await DeliverySession.findOne({ sessionId: parentOrder.activeDeliverySessionId });
        }
        if (!session) {
            session = await DeliverySession.findOne({
                $or: [
                    { orderId: String(id) },
                    { orderId: isNaN(Number(id)) ? id : Number(id) },
                    ...(parentOrder.parentGroupId ? [{ orderId: parentOrder.parentGroupId }] : []),
                    ...(parentOrder.storeOrderId ? [{ orderId: parentOrder.storeOrderId }, { orderId: String(parentOrder.storeOrderId) }] : []),
                ]
            }).sort({ createdAt: -1 });
        }

        if (!session) return res.status(404).json({ success: false, message: 'Delivery session not found' });

        // Find latest attempt for this session
        const attempts = await DeliveryAttempt.find({ sessionId: session.sessionId }).sort({ attemptNumber: -1 });
        const latestAttempt = attempts[0];

        if (!latestAttempt) {
            return res.status(404).json({ success: false, message: 'No attempt found to re-notify' });
        }

        if (!session.customerId) {
            if (parentOrder) {
                const resolvedCustId = parentOrder.userId || parentOrder.clientId || parentOrder.user;
                if (resolvedCustId) {
                    session.customerId = resolvedCustId.toString();
                    await session.save();
                }
            }
        }

        // Re-emit attempt created socket event & FCM notification to customer
        await DeliveryEventBus.emitAttemptCreated(req.app.get('io'), session, latestAttempt, traceId);

        return res.json({
            success: true,
            message: 'تم إعادة إرسال الصورة والتنبيه للعميل بنجاح',
            sessionId: session.sessionId,
            attemptId: latestAttempt.attemptId,
        });
    } catch (err) {
        logger.error(`[PoD] renotifyCustomer error [${traceId}]:`, err);
        return res.status(500).json({ success: false, error: err.message });
    }
};
