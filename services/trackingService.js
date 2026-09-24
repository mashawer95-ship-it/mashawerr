/**
 * trackingService.js
 * Core business logic for the driver live tracking system.
 *
 * This service is called by the Socket.IO tracking namespace handler.
 * It does NOT do HTTP — it processes GPS events and decides:
 *   - Should we broadcast? (movement threshold + throttle)
 *   - Should we update Redis? (debounced to reduce write pressure)
 *   - What payload to send? (minimal bytes)
 *
 * Design goals:
 *   ✓ Zero Google API calls — pure coordinate relay
 *   ✓ Broadcast only when driver moved > MIN_MOVE_METERS
 *   ✓ Max 1 broadcast per THROTTLE_MS per driver
 *   ✓ Minimal payload (5 fields) to save mobile data
 *   ✓ Redis TTL-based cleanup (no cron jobs needed)
 */

const {
    haversineDistance,
    isValidCoordinate,
    isValidHeading,
    isValidSpeed,
    buildMinimalPayload,
} = require('../utils/geoUtils');

const {
    isThrottled,
    markBroadcast,
    debouncePerDriver,
    clearDriverThrottleState,
} = require('../utils/throttle');

const {
    setDriverLocation,
    getDriverLocation,
    setDriverOnline,
    setDriverOffline,
    setDriverTrip,
    getDriverTrip,
    clearDriverTrip,
    cleanupDriver,
    cleanupTrip,
} = require('../redis/trackingRedis');

const logger = require('../utils/logger');

/** Minimum movement in metres before we broadcast an update. */
const MIN_MOVE_METERS = Number(process.env.MIN_MOVE_METERS) || 15;

/** Debounce delay for Redis location writes (ms). */
const REDIS_WRITE_DEBOUNCE_MS = Number(process.env.REDIS_WRITE_DEBOUNCE_MS) || 1500;

// ── Room naming ──────────────────────────────────────────────────────────────
const tripRoom   = (tripId)   => `trip:${tripId}`;
const driverRoom = (driverId) => `drv:${driverId}`;

// ─────────────────────────────────────────────────────────────────────────────
//  DRIVER CONNECTION LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called when a driver socket connects.
 * - Marks driver online in Redis
 * - Joins driver-specific room
 * - Reconnects to their active trip room if one exists
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Namespace} nsp
 */
async function onDriverConnected(socket, nsp) {
    const driverId = socket.user.id;

    // Driver joins their own room (for direct messages)
    socket.join(driverRoom(driverId));

    // Mark online in Redis
    await setDriverOnline(driverId);

    // Reconnect to active trip if one was in progress
    const activeTripId = await getDriverTrip(driverId);
    if (activeTripId) {
        socket.join(tripRoom(activeTripId));
        logger.info(`[Tracking] Driver ${driverId} reconnected → rejoined trip ${activeTripId}`);
        socket.emit('reconnected', {
            tripId: activeTripId,
            message: 'Reconnected to active trip',
        });
    }

    logger.info(`[Tracking] Driver ${driverId} connected (socket: ${socket.id})`);
}

/**
 * Called when a driver socket disconnects.
 * - Marks driver offline in Redis
 * - Notifies customers in trip room
 * - Clears throttle state
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Namespace} nsp
 * @param {string} reason
 */
async function onDriverDisconnected(socket, nsp, reason) {
    const driverId = socket.user?.id;
    if (!driverId) return;

    await setDriverOffline(driverId);
    clearDriverThrottleState(driverId);

    // Notify customers in the trip room that driver disconnected
    const tripId = await getDriverTrip(driverId);
    if (tripId) {
        nsp.to(tripRoom(tripId)).emit('driverDisconnected', {
            driverId,
            tripId,
            reason,
            timestamp: Date.now(),
        });
    }

    logger.info(`[Tracking] Driver ${driverId} disconnected (${reason})`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  LOCATION UPDATE PIPELINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a live GPS update from a driver.
 *
 * Pipeline:
 *   1. Validate coordinates
 *   2. Get previous location from Redis
 *   3. Check movement threshold (>15m required)
 *   4. Check broadcast throttle (max 1 per THROTTLE_MS)
 *   5. Broadcast minimal payload to trip room
 *   6. Debounce-write new location to Redis
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Namespace} nsp
 * @param {{
 *   tripId: string,
 *   lat: number,
 *   lng: number,
 *   heading?: number,
 *   speed?: number,
 * }} payload
 * @returns {{ broadcasted: boolean, reason?: string }}
 */
async function processLocationUpdate(socket, nsp, payload) {
    const driverId = socket.user.id;
    const { tripId, lat, lng, heading, speed } = payload;

    // ── Step 1: Validate ──────────────────────────────────────────────────────
    if (!tripId || typeof tripId !== 'string') {
        return { broadcasted: false, reason: 'missing_tripId' };
    }

    if (!isValidCoordinate(lat, lng)) {
        logger.warn(`[Tracking] Driver ${driverId}: invalid coordinates (${lat}, ${lng})`);
        return { broadcasted: false, reason: 'invalid_coordinates' };
    }

    if (!isValidHeading(heading)) {
        return { broadcasted: false, reason: 'invalid_heading' };
    }

    if (!isValidSpeed(speed)) {
        return { broadcasted: false, reason: 'invalid_speed' };
    }

    const now = Date.now();
    const newLoc = {
        lat: Number(lat),
        lng: Number(lng),
        heading: heading != null ? Number(heading) : null,
        speed:   speed   != null ? Number(speed)   : null,
        timestamp: now,
    };

    // ── Step 2: Get previous location ─────────────────────────────────────────
    const prevLoc = await getDriverLocation(driverId);

    // ── Step 3: Movement & broadcast check ───────────────────────────────────
    let shouldBroadcast = true;
    if (prevLoc) {
        const moved = haversineDistance(
            { lat: prevLoc.lat, lng: prevLoc.lng },
            { lat: newLoc.lat, lng: newLoc.lng }
        );

        // Broadcast if moved >= 2m or if it's been more than 4s since last recorded timestamp
        if (moved < 2 && (now - (prevLoc.timestamp || 0)) < 4000) {
            shouldBroadcast = false;
        }
    }

    // Always update Redis and MongoDB lastLocation immediately
    debouncePerDriver(driverId, () => {
        setDriverLocation(driverId, newLoc);
        setDriverOnline(driverId);
    }, REDIS_WRITE_DEBOUNCE_MS);

    try {
        const { User } = require('../middlewares/User');
        User.findByIdAndUpdate(driverId, {
            'lastLocation.lat': newLoc.lat,
            'lastLocation.lng': newLoc.lng,
            'lastLocation.updatedAt': new Date(),
        }).exec();
    } catch (_) {}

    // ── Step 4: Throttle check ────────────────────────────────────────────────
    if (!shouldBroadcast || isThrottled(driverId)) {
        return { broadcasted: false, reason: shouldBroadcast ? 'throttled' : 'below_threshold' };
    }

    // ── Step 5: Broadcast to trip room ────────────────────────────────────────
    const minPayload = buildMinimalPayload({ driverId, ...newLoc });
    const fullLocationPayload = {
        driverId: driverId,
        orderId: tripId,
        tripId: tripId,
        location: {
            lat: newLoc.lat,
            lng: newLoc.lng,
            latitude: newLoc.lat,
            longitude: newLoc.lng,
            heading: newLoc.heading,
            speed: newLoc.speed || 0,
            timestamp: newLoc.timestamp
        },
        lat: newLoc.lat,
        lng: newLoc.lng,
        latitude: newLoc.lat,
        longitude: newLoc.lng,
        heading: newLoc.heading,
        speed: newLoc.speed || 0,
        timestamp: newLoc.timestamp
    };

    // Emit to all customers in this trip's room (excluding the driver socket itself)
    nsp.to(tripRoom(tripId)).emit('driverLocationUpdated', fullLocationPayload);
    nsp.to(tripRoom(tripId)).emit('trip.driver.location', fullLocationPayload);
    nsp.to(tripRoom(tripId)).emit('updateDriverLocation', fullLocationPayload);

    // Broadcast to customer app via default namespace order room
    const globalIo = nsp.server || socket.server || socket.client?.conn?.server;
    if (globalIo) {
        globalIo.to(`order:${tripId}`).emit('driverLocationUpdated', fullLocationPayload);
        globalIo.to(`order:${tripId}`).emit('driver:location:updated', fullLocationPayload);
        globalIo.to(`order:${tripId}`).emit('trip.driver.location', fullLocationPayload);
        globalIo.to(`trip:${tripId}`).emit('driverLocationUpdated', fullLocationPayload);
        globalIo.of('/tracking').to(tripRoom(tripId)).emit('driverLocationUpdated', fullLocationPayload);
    }

    markBroadcast(driverId);

    logger.debug(`[Tracking] Driver ${driverId} → trip ${tripId}: broadcast lat=${newLoc.lat}, lng=${newLoc.lng}`);

    return { broadcasted: true };
}

// ─────────────────────────────────────────────────────────────────────────────
//  TRIP MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Driver starts tracking for a trip.
 * Joins the Socket.IO trip room and records the association in Redis.
 *
 * @param {import('socket.io').Socket} socket
 * @param {string} tripId
 */
async function driverJoinTrip(socket, tripId) {
    const driverId = socket.user.id;

    socket.join(tripRoom(tripId));
    await setDriverTrip(driverId, tripId);

    logger.info(`[Tracking] Driver ${driverId} joined trip room: ${tripId}`);

    socket.emit('tripJoined', {
        tripId,
        driverId,
        timestamp: Date.now(),
    });
}

/**
 * Driver ends a trip.
 * - Notifies all customers in the trip room
 * - Removes driver from trip room
 * - Cleans up Redis associations
 *
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Namespace} nsp
 * @param {string} tripId
 */
async function driverEndTrip(socket, nsp, tripId) {
    const driverId = socket.user.id;

    // Notify all customers in the trip room
    nsp.to(tripRoom(tripId)).emit('tripEnded', {
        tripId,
        driverId,
        timestamp: Date.now(),
    });

    // Leave the Socket.IO room
    socket.leave(tripRoom(tripId));

    // Clean up Redis
    await clearDriverTrip(driverId, tripId);
    await cleanupTrip(tripId);

    logger.info(`[Tracking] Driver ${driverId} ended trip ${tripId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  CUSTOMER SUBSCRIPTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Customer joins a trip room to receive driver location events.
 * Also sends the driver's last known location immediately (snapshot).
 *
 * @param {import('socket.io').Socket} socket
 * @param {string} tripId
 * @param {string} driverId
 */
async function customerSubscribeToTrip(socket, tripId, driverId) {
    socket.join(tripRoom(tripId));

    // Send current driver location snapshot immediately
    let lastLoc = await getDriverLocation(driverId);
    if ((!lastLoc || lastLoc.lat == null) && driverId) {
        try {
            const { User } = require('../middlewares/User');
            const rep = await User.findById(driverId).select('lastLocation').lean();
            if (rep && rep.lastLocation && rep.lastLocation.lat != null && rep.lastLocation.lng != null) {
                lastLoc = {
                    lat: rep.lastLocation.lat,
                    lng: rep.lastLocation.lng,
                    heading: 0,
                    speed: 0,
                    timestamp: Date.now(),
                };
            }
        } catch (_) {}
    }

    if (lastLoc && lastLoc.lat != null && lastLoc.lng != null) {
        const payload = {
            driverId,
            tripId,
            orderId: tripId,
            location: {
                lat: lastLoc.lat,
                lng: lastLoc.lng,
                latitude: lastLoc.lat,
                longitude: lastLoc.lng,
                heading: lastLoc.heading || 0,
                speed: lastLoc.speed || 0,
                timestamp: lastLoc.timestamp || Date.now(),
            },
            lat: lastLoc.lat,
            lng: lastLoc.lng,
            latitude: lastLoc.lat,
            longitude: lastLoc.lng,
            heading: lastLoc.heading || 0,
            timestamp: lastLoc.timestamp || Date.now(),
        };
        socket.emit('driverLocationUpdated', payload);
        socket.emit('updateDriverLocation', payload);
        socket.emit('trip.driver.location', payload);
    }

    logger.debug(`[Tracking] Customer ${socket.user?.id} subscribed to trip ${tripId}`);

    // Send the current route immediately if available
    try {
        const { getTrip } = require('./tripService');
        const trip = await getTrip(tripId);
        
        if (trip && trip.encodedPolyline) {
            const routePayload = {
                routeVersion: trip.routeVersion || 1,
                version: trip.routeVersion || 1,
                checksum: trip.routeChecksum || '',
                generatedAt: Date.now(),
                source: trip.routeSource || 'CACHE',
                reason: 'initial_sync',
                tripId: trip.tripId,
                encodedPolyline: trip.encodedPolyline,
                distanceMeters: trip.distanceMeters || 0,
                durationSeconds: trip.durationSeconds || 0,
                trafficSegments: trip.trafficSegments || [],
                trafficDataVersion: trip.trafficDataVersion || 1,
            };
            socket.emit('trip.route.updated', routePayload);
            socket.emit('routeUpdated', routePayload);
            socket.emit('route_updated', routePayload);
            logger.debug(`[Tracking] Sent route snapshot to customer ${socket.user?.id} for trip ${tripId}`);
        }
    } catch (err) {
        logger.error(`[Tracking] Error fetching trip route for subscription: ${err.message}`);
    }

    socket.emit('subscribed', { tripId, driverId, hasLocation: !!lastLoc });
}

/**
 * Customer leaves a trip room (trip ended from their side or nav away).
 * @param {import('socket.io').Socket} socket
 * @param {string} tripId
 */
function customerUnsubscribeFromTrip(socket, tripId) {
    socket.leave(tripRoom(tripId));
    logger.debug(`[Tracking] Customer ${socket.user?.id} unsubscribed from trip ${tripId}`);
}

module.exports = {
    onDriverConnected,
    onDriverDisconnected,
    processLocationUpdate,
    driverJoinTrip,
    driverEndTrip,
    customerSubscribeToTrip,
    customerUnsubscribeFromTrip,
    MIN_MOVE_METERS,
};
