/**
 * DeliveryEventBus.js
 * Multi-room & multi-namespace Realtime Event Bus with FCM Push Notification Fallback.
 * Ensures representative/driver receives instant updates when customer approves delivery photo.
 */

const crypto = require('crypto');
const { DeliveryEvent } = require('../models/DeliveryEvent');
const logger = require('../utils/logger');
const { notifyClient } = require('./notifyClient');

class DeliveryEventBus {

    /**
     * Dispatch event across multiple rooms, namespaces, and FCM Push Notification.
     */
    static async _dispatch({ sessionId, traceId, actor, action, payload = {}, socketConfig, fcmConfig }) {
        try {
            const eventId = crypto.randomUUID();
            const safeTraceId = traceId || crypto.randomUUID();
            const safeSessionId = sessionId || payload.sessionId || 'session_default';
            const timestamp = new Date();

            // 1. Audit Log (MongoDB)
            try {
                await DeliveryEvent.create({
                    eventId,
                    sessionId: safeSessionId,
                    traceId: safeTraceId,
                    actor: actor || 'SYSTEM',
                    action: action || 'EVENT',
                    payload,
                    timestamp,
                });
            } catch (dbErr) {
                logger.warn(`[PoD EventBus] Audit log insert error: ${dbErr.message}`);
            }

            logger.info(`[PoD EventBus] Action: ${action} | Session: ${safeSessionId} | Trace: ${safeTraceId} | Actor: ${actor}`, payload);

            // 2. Realtime Broadcast across rooms and namespaces
            if (socketConfig) {
                const { io, rooms = [], eventNames = [], data = {} } = socketConfig;

                const socketPayload = {
                    version: 2,
                    eventId,
                    sessionId,
                    timestamp: timestamp.getTime(),
                    traceId,
                    ...payload,
                    ...data,
                };

                if (io) {
                    for (const room of rooms) {
                        for (const eventName of eventNames) {
                            // Default namespace broadcast
                            io.to(room).emit(eventName, socketPayload);

                            // /tracking namespace broadcast
                            try {
                                io.of('/tracking').to(room).emit(eventName, socketPayload);
                            } catch (e) { }

                            // /ride namespace broadcast
                            try {
                                io.of('/ride').to(room).emit(eventName, socketPayload);
                            } catch (e) { }
                        }
                    }
                }
            }

            // 3. FCM Push Notification Fallback
            if (fcmConfig && fcmConfig.targetUserId) {
                const { targetUserId, title, body, notificationData } = fcmConfig;
                // Fire-and-forget push notification (non-blocking)
                notifyClient(targetUserId, title, body, notificationData).catch(err => {
                    logger.warn(`[PoD EventBus] FCM Push failed for ${targetUserId}: ${err.message}`);
                });
            }

            return eventId;
        } catch (error) {
            logger.error(`[DeliveryEventBus] Error dispatching event: ${action}`, error);
        }
    }

    static async emitAttemptCreated(io, session, attempt, traceId) {
        const photoUrl = attempt.photo?.cdnUrl ||
            (attempt.photo?.objectKey
                ? (attempt.photo.objectKey.startsWith('http')
                    ? attempt.photo.objectKey
                    : `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${attempt.photo.objectKey}`)
                : null);

        const isPickup = (attempt.phase === 'PICKUP' || session.phase === 'PICKUP');
        const eventNames = isPickup
            ? ['pickup_session:attempt_created', 'order:pickup_attempt_created', 'delivery_session:attempt_created', 'order:pod_attempt_created']
            : ['delivery_session:attempt_created', 'order:pod_attempt_created'];

        const title = isPickup ? 'صورة استلام البضاعة 📦' : 'صورة إثبات التسليم 📦';
        const body = isPickup
            ? 'قام المندوب برفع صورة استلام البضاعة. يرجى الدخول لمراجعة الصورة وتأكيد الاستلام.'
            : 'قام المندوب برفع صورة التسليم. يرجى الدخول لمراجعة الصورة وتأكيد التسليم.';

        return this._dispatch({
            sessionId: session.sessionId,
            traceId,
            actor: 'DRIVER',
            action: isPickup ? 'PICKUP_ATTEMPT_CREATED' : 'ATTEMPT_CREATED',
            payload: {
                attemptId: attempt.attemptId,
                photoUrl: photoUrl,
                imageUrl: photoUrl,
                orderId: session.orderId,
                phase: isPickup ? 'PICKUP' : 'DELIVERY',
            },
            socketConfig: {
                io,
                rooms: [`user:${session.customerId}`, `order:${session.orderId}`, `trip:${session.orderId}`],
                eventNames: eventNames,
            },
            fcmConfig: {
                targetUserId: session.customerId,
                title: title,
                body: body,
                notificationData: {
                    type: isPickup ? 'PICKUP_REQUIRES_REVIEW' : 'DELIVERY_REQUIRES_REVIEW',
                    orderId: String(session.orderId),
                    sessionId: session.sessionId,
                    attemptId: attempt.attemptId,
                    photoUrl: photoUrl || '',
                    imageUrl: photoUrl || '',
                    phase: isPickup ? 'PICKUP' : 'DELIVERY',
                },
            },
        });
    }

    static async emitAttemptRejected(io, session, attempt, reason, traceId) {
        const isPickup = (attempt.phase === 'PICKUP' || session.phase === 'PICKUP');
        const title = isPickup ? 'تم تحفظ العميل على صورة الاستلام ❌' : 'تم تحفظ العميل على صورة التسليم ❌';
        const body = isPickup
            ? `العميل تحفظ على صورة الاستلام (${reason || 'بدون سبب'}). يرجى التواصل أو إعادة الرفع.`
            : `العميل تحفظ على صورة التسليم (${reason || 'بدون سبب'}). يرجى التواصل أو إعادة الرفع.`;
        const eventNames = isPickup
            ? ['pickup_session:attempt_rejected', 'pickup_session:rejected', 'order:pickup_rejected', 'delivery_session:attempt_rejected', 'delivery_session:rejected', 'order:pod_rejected']
            : ['delivery_session:attempt_rejected', 'delivery_session:rejected', 'order:pod_rejected'];

        return this._dispatch({
            sessionId: session.sessionId,
            traceId,
            actor: 'CUSTOMER',
            action: isPickup ? 'PICKUP_ATTEMPT_REJECTED' : 'ATTEMPT_REJECTED',
            payload: { attemptId: attempt.attemptId, reason, orderId: session.orderId, phase: isPickup ? 'PICKUP' : 'DELIVERY' },
            socketConfig: {
                io,
                rooms: [`user:${session.driverId}`, `order:${session.orderId}`, `trip:${session.orderId}`],
                eventNames: eventNames,
            },
            fcmConfig: {
                targetUserId: session.driverId,
                title: title,
                body: body,
                notificationData: {
                    type: isPickup ? 'PICKUP_REJECTED' : 'POD_REJECTED',
                    orderId: String(session.orderId),
                    sessionId: session.sessionId,
                    phase: isPickup ? 'PICKUP' : 'DELIVERY',
                },
            },
        });
    }

    static async emitPickupApproved(io, session, trackData = null, traceId = null) {
        const orderId = session.orderId;
        const allPickupsDone = trackData?.allPickupsDone ?? true;
        const currentStop = trackData?.currentStop;
        const currentStopIndex = trackData?.currentStopIndex ?? 0;
        const totalStops = trackData?.totalStops ?? 2;
        const phase = trackData?.phase ?? (allPickupsDone ? 'DELIVERY' : 'PICKUP');

        const title = 'تم اعتماد صورة الاستلام ✅';
        const body = allPickupsDone
            ? 'قام العميل باعتماد صورة الاستلام بنجاح! يمكنك الآن التوجه إلى مرحلة التسليم 🚚'
            : (currentStop
                ? `تم اعتماد الاستلام بنجاح! التوجه الآن إلى ${currentStop.title} 🚚`
                : 'تم اعتماد الاستلام بنجاح! يمكنك المتابعة للاستلام التالي 🚚');

        const roomsSet = new Set([
            `user:${session.driverId}`,
            `order:${session.orderId}`,
            `order:${orderId}`,
            `trip:${session.orderId}`,
            `trip:${orderId}`,
            ...(trackData?.extraRooms || [])
        ]);

        return this._dispatch({
            sessionId: session.sessionId,
            traceId,
            actor: 'CUSTOMER',
            action: 'PICKUP_APPROVED',
            payload: {
                orderId: session.orderId,
                isApproved: true,
                subState: session.subState,
                phase: phase,
                allPickupsCompleted: allPickupsDone,
                currentStopIndex: currentStopIndex,
                currentStop: currentStop,
                totalStops: totalStops,
                track: trackData,
                message: body,
            },
            socketConfig: {
                io,
                rooms: Array.from(roomsSet),
                eventNames: [
                    'pickup_session:approved',
                    'order:track_updated',
                ],
            },
            fcmConfig: {
                targetUserId: session.driverId,
                title: title,
                body: body,
                notificationData: {
                    type: 'PICKUP_APPROVED',
                    orderId: String(session.orderId),
                    sessionId: session.sessionId,
                    phase: phase,
                    currentStopIndex: String(currentStopIndex),
                    allPickupsCompleted: String(allPickupsDone),
                },
            },
        });
    }

    static async emitAiRejected(io, session, attempt, traceId) {
        return this._dispatch({
            sessionId: session.sessionId,
            traceId,
            actor: 'AI_SERVICE',
            action: 'AI_REJECTED',
            payload: { attemptId: attempt.attemptId, reason: attempt.rejectionReason, orderId: session.orderId },
            socketConfig: {
                io,
                rooms: [`user:${session.driverId}`, `order:${session.orderId}`, `trip:${session.orderId}`],
                eventNames: ['delivery_session:ai_rejected', 'order:pod_ai_rejected'],
            },
        });
    }

    static async emitDeliveryApproved(io, session, attempt, orderId, allTasksCompleted = false, extraRooms = [], trackData = null, traceId = null) {
        const roomsSet = new Set([
            `user:${session.driverId}`,
            `order:${session.orderId}`,
            `order:${orderId}`,
            `trip:${session.orderId}`,
            `trip:${orderId}`,
            ...extraRooms.filter(Boolean)
        ]);

        const currentStop = trackData?.currentStop;
        const currentStopIndex = trackData?.currentStopIndex ?? (allTasksCompleted ? (trackData?.totalStops ? trackData.totalStops - 1 : 0) : 0);
        const totalStops = trackData?.totalStops ?? 2;

        const body = allTasksCompleted
            ? 'تم اعتماد صورة التسليم وإكمال الطلب بالكامل بنجاح 🎉'
            : (currentStop
                ? `تم اعتماد صورة التسليم بنجاح! التوجه الآن إلى ${currentStop.title} 🚚`
                : 'تم اعتماد صورة تسليم هذا المنتج بنجاح! يرجى التوجه لتسليم المنتج التالي 🚚');

        return this._dispatch({
            sessionId: session.sessionId,
            traceId,
            actor: 'CUSTOMER',
            action: 'DELIVERY_APPROVED',
            payload: {
                orderId: session.orderId || orderId,
                attemptId: attempt?.attemptId,
                isApproved: true,
                allTasksCompleted: allTasksCompleted,
                subState: session.subState,
                phase: trackData?.phase || (allTasksCompleted ? 'COMPLETED' : 'DELIVERY'),
                currentStopIndex: currentStopIndex,
                currentStop: currentStop,
                totalStops: totalStops,
                track: trackData,
                message: body,
            },
            socketConfig: {
                io,
                rooms: Array.from(roomsSet),
                eventNames: [
                    'delivery_session:approved',
                    'order:track_updated',
                ],
            },
            fcmConfig: {
                targetUserId: session.driverId,
                title: 'تم اعتماد صورة التسليم ✅',
                body: body,
                notificationData: {
                    type: 'POD_APPROVED',
                    orderId: String(orderId || session.orderId),
                    sessionId: session.sessionId,
                    phase: 'DELIVERY',
                    currentStopIndex: String(currentStopIndex),
                    allTasksCompleted: String(allTasksCompleted),
                },
            },
        });
    }

    static async emitOtpGenerated(io, session, traceId) {
        return this._dispatch({
            sessionId: session.sessionId,
            traceId,
            actor: 'SYSTEM',
            action: 'OTP_GENERATED',
            payload: {
                otpVersion: session.otpVersion,
                orderId: session.orderId,
                isApproved: true,
                subState: session.subState,
            },
            socketConfig: {
                io,
                rooms: [`user:${session.driverId}`, `order:${session.orderId}`, `trip:${session.orderId}`],
                eventNames: [
                    'delivery_session:otp_generated',
                    'delivery_session:approved',
                    'order:pod_approved',
                    'order:status_changed',
                ],
            },
            fcmConfig: {
                targetUserId: session.driverId,
                title: 'تم اعتماد صورة التسليم ✅',
                body: 'قام العميل باعتمد صورة التسليم بنجاح وإكمال الطلب.',
                notificationData: {
                    type: 'POD_APPROVED',
                    orderId: String(session.orderId),
                    sessionId: session.sessionId,
                },
            },
        });
    }

    static async emitDeliveryCompleted(io, session, orderId, traceId) {
        return this._dispatch({
            sessionId: session.sessionId,
            traceId,
            actor: 'DRIVER',
            action: 'DELIVERY_COMPLETED',
            payload: { orderId, isCompleted: true, phase: 'COMPLETED' },
            socketConfig: {
                io,
                rooms: [`user:${session.customerId}`, `user:${session.driverId}`, `order:${orderId}`, `trip:${orderId}`],
                eventNames: ['delivery_session:completed', 'order:completed', 'tripCompleted'],
            },
            fcmConfig: {
                targetUserId: session.customerId,
                title: 'تم إكمال التسليم بنجاح 🎉',
                body: 'تم استلام طلبك وتأكيده بنجاح. شكراً لاستخدامك وصول!',
                notificationData: {
                    type: 'DELIVERY_COMPLETED',
                    orderId: String(orderId),
                },
            },
        });
    }

    static async emitPickupCompleted(io, session, orderId, trackData = null, traceId = null) {
        const allPickupsDone = trackData?.allPickupsDone ?? true;
        const phase = trackData?.phase || (allPickupsDone ? 'DELIVERY' : 'PICKUP');
        const status = allPickupsDone ? 'delivering' : 'processing';

        const roomsSet = new Set([
            `user:${session.customerId}`,
            `user:${session.driverId}`,
            `order:${orderId}`,
            `trip:${orderId}`,
            ...(trackData?.extraRooms || [])
        ]);

        return this._dispatch({
            sessionId: session.sessionId,
            traceId,
            actor: 'DRIVER',
            action: 'PICKUP_COMPLETED',
            payload: {
                orderId,
                phase: phase,
                status: status,
                allPickupsCompleted: allPickupsDone,
                currentStopIndex: trackData?.currentStopIndex ?? 0,
                currentStop: trackData?.currentStop,
                totalStops: trackData?.totalStops ?? 2,
            },
            socketConfig: {
                io,
                rooms: Array.from(roomsSet),
                eventNames: ['pickup_session:completed', 'order:pickup_completed', 'order:status_changed', 'order:track_updated'],
            },
            fcmConfig: {
                targetUserId: session.customerId,
                title: 'تم توثيق الاستلام بنجاح 🚚',
                body: allPickupsDone
                    ? 'تم استلام كافة البضائع بنجاح، والمندوب في طريقه لتسليم طلبك!'
                    : 'تم استلام جزء من المنتجات بنجاح، والمندوب في طريقه لإكمال باقي الاستلامات.',
                notificationData: {
                    type: 'PICKUP_COMPLETED',
                    orderId: String(orderId),
                    phase: phase,
                },
            },
        });
    }
}

module.exports = { DeliveryEventBus };
