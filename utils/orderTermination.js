/**
 * orderTermination.js
 *
 * Single place that tears down EVERYTHING attached to an order when it stops
 * being "live" (client cancel, rep cancel/release).
 *
 *  - Emits one consistent set of realtime events to every room/party.
 *  - Ends the live tracking trip on the /tracking namespace and evicts all
 *    sockets from the trip/order rooms (so no more driver location fan-out).
 *  - Writes a short-lived Redis tombstone that the location hot path checks,
 *    so a late GPS packet from the driver app can never resurrect the trip.
 *  - Deletes route/pose/eta cache keys and closes the Trip document.
 *
 * Performance notes (scale):
 *  - Fire-and-forget friendly: every step is individually try/caught.
 *  - One Redis DEL (multi-key) + one SET for the tombstone, one Mongo
 *    updateMany. No scans, no per-socket loops (socketsLeave is a single
 *    adapter broadcast, cluster-wide with the redis adapter).
 */

const logger = require('./logger');
const { redisSet, redisDel } = require('../config/redis');

const TOMBSTONE_TTL_SECONDS = 60 * 60; // 1h is far longer than any in-flight GPS packet
const tombstoneKey = (id) => `trip:ended:${id}`;

function collectIds(order, extraId) {
    const ids = new Set();
    if (extraId) ids.add(String(extraId));
    if (order?.orderId != null) ids.add(String(order.orderId));
    if (order?._id) ids.add(String(order._id));
    return [...ids];
}

/**
 * @param {object} params
 * @param {import('socket.io').Server} params.io
 * @param {object} params.order           Mongoose order doc (post-update)
 * @param {'cancelled'|'waiting'|'return_pending'} params.status  New status
 * @param {string} params.previousStatus
 * @param {'client'|'representative'|'admin'|'system'} params.cancelledBy
 * @param {string} [params.reason]
 * @param {string|null} [params.representativeId]  Rep that was attached BEFORE the change
 * @param {boolean} [params.isRelease]    true => order goes back to waiting (rep released)
 */
async function terminateOrderTracking({
    io,
    order,
    status,
    previousStatus,
    cancelledBy,
    reason,
    representativeId,
    isRelease = false,
    emitStatusEvents = true,
    extraId,
}) {
    const ids = collectIds(order, extraId);
    if (ids.length === 0) return;

    const clientId = order.clientId ? String(order.clientId) : null;
    const repId = representativeId ? String(representativeId) : null;
    const mongoId = order._id ? String(order._id) : ids[0];
    const numericId = order.orderId != null ? String(order.orderId) : ids[0];

    const base = {
        orderId: numericId,
        _id: mongoId,
        id: mongoId,
        status,
        previousStatus,
        cancelledBy,
        reason: reason || null,
        cancellationReason: reason || null,
        timestamp: Date.now(),
    };

    const isCompletedStatus = status === 'completed' || status === 'delivered';

    // 1) Tombstone first: closes the race with in-flight GPS packets.
    // (Skipped for release: the order returns to waiting and a new rep will track it.)
    try {
        if (!isRelease) {
            await Promise.all(ids.map((id) => redisSet(tombstoneKey(id), '1', TOMBSTONE_TTL_SECONDS)));
        }
    } catch (e) {
        logger.warn(`[terminateOrderTracking] tombstone failed: ${e.message}`);
    }

    // 2) Realtime fan-out (order rooms + both user rooms + admin)
    try {
        if (io) {
            const targets = io;
            const emitAll = (event, payload) => {
                let chain = targets;
                for (const id of ids) chain = chain.to(`order:${id}`);
                if (clientId) chain = chain.to(`user:${clientId}`);
                if (repId) chain = chain.to(`user:${repId}`);
                chain.to('admin:orders').emit(event, payload);
            };

            if (emitStatusEvents) {
                emitAll('order:status_changed', { ...base, message: `Order status changed to ${status}` });
                if (isRelease) {
                    emitAll('order:back_to_waiting', base);
                    emitAll('order:released', base);
                } else if (isCompletedStatus) {
                    emitAll('order:completed', { ...base, isCompleted: true, allTasksCompleted: true });
                } else {
                    emitAll('order:cancelled', base);
                }
            }

            // 3) End the live trip for every subscriber on every namespace
            const tripEndReason = isRelease ? 'released' : (isCompletedStatus ? 'completed' : 'cancelled');
            const tripEnded = { tripId: mongoId, orderId: numericId, reason: tripEndReason, timestamp: Date.now() };
            const namespaces = [io.of('/tracking'), io.of('/ride')].filter(Boolean);
            for (const nsp of namespaces) {
                let chain = nsp;
                for (const id of ids) chain = chain.to(`trip:${id}`).to(`order:${id}`);
                chain.emit('tripEnded', tripEnded);
            }

            // 4) Evict sockets from trip/order rooms so nothing else is fanned out.
            //    (single adapter call per room, cluster-wide via redis adapter)
            for (const nsp of namespaces) {
                for (const id of ids) {
                    nsp.in(`trip:${id}`).socketsLeave([`trip:${id}`, `order:${id}`, `trip_${id}`]);
                    nsp.in(`order:${id}`).socketsLeave([`trip:${id}`, `order:${id}`, `trip_${id}`]);
                }
            }
            // The "order:" rooms on the root namespace are used by the order
            // sockets (not by tracking). The status events above are already
            // delivered, so evict them too for a cancel/complete (but keep for release,
            // since the client keeps waiting for a new rep on the same order).
            if (!isRelease) {
                for (const id of ids) io.in(`order:${id}`).socketsLeave(`order:${id}`);
            }
        }
    } catch (e) {
        logger.error(`[terminateOrderTracking] socket teardown error: ${e.message}`);
    }

    // 5) Cache + persistence cleanup
    try {
        const keys = [];
        for (const id of ids) {
            keys.push(
                `active_route:${id}`,
                `trip:${id}`,
                `trip:${id}:snapshot`,
                `trip:${id}:pose`,
                `trip:${id}:eta`,
                `order_route:${id}`,
            );
        }
        await redisDel(...keys);
    } catch (e) {
        logger.warn(`[terminateOrderTracking] redis cleanup error: ${e.message}`);
    }

    try {
        const { Trip } = require('../models/Trip');
        const tripEndStatus = isRelease ? 'released' : (isCompletedStatus ? 'completed' : 'cancelled');
        await Trip.updateMany(
            { $or: [{ orderId: { $in: ids } }, { _id: order._id }] },
            { $set: { status: tripEndStatus, endedAt: new Date() } },
        );
    } catch (_) { /* Trip doc is optional */ }

    try {
        const { clearTripState } = require('./offRouteDetector');
        await Promise.all(ids.map((id) => clearTripState(id)));
    } catch (_) { }

    try {
        if (repId) {
            const { clearDriverTrip, cleanupTrip } = require('../redis/trackingRedis');
            await Promise.all(ids.map((id) => clearDriverTrip(repId, id).catch(() => { })));
            await Promise.all(ids.map((id) => cleanupTrip(id).catch(() => { })));
        }
    } catch (_) { }
}

/** Cheap check used by the GPS hot path. Returns true if trip was torn down. */
async function isTripTerminated(ids) {
    try {
        const { redisGet } = require('../config/redis');
        for (const id of ids) {
            if (id && (await redisGet(tombstoneKey(id)))) return true;
        }
    } catch (_) { }
    return false;
}

/** Called when an order legitimately goes live again (new rep accepts). */
async function clearTerminationTombstone(ids) {
    try {
        await redisDel(...ids.filter(Boolean).map(tombstoneKey));
    } catch (_) { }
}

module.exports = { terminateOrderTracking, isTripTerminated, clearTerminationTombstone };
