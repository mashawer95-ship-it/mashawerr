/**
 * rideSocket.js
 * Socket.IO event handlers for the ride-tracking module.
 *
 * This file registers all Socket.IO event listeners on the global io instance.
 * It is called once from app.js after Socket.IO is initialized.
 *
 * ── Room naming convention ──────────────────────────────────────────────────
 *   trip:{tripId}       → all parties in a trip (driver + client + dispatcher)
 *   driver:{driverId}   → driver-specific events
 *
 * ── Events received from Flutter client ─────────────────────────────────────
 *   join_trip            { tripId, role: 'driver'|'client'|'dispatcher' }
 *   leave_trip           { tripId }
 *   ping                 { tripId }   → heartbeat
 *
 * ── Events emitted BY SERVER (defined here for reference, emitted from services):
 *   driverLocationUpdated  { tripId, driverId, location, timestamp }
 *   routeUpdated           { tripId, encodedPolyline, distanceMeters, durationSeconds, reason }
 *   tripCompleted          { tripId, driverId, completedAt }
 *
 * ── Reconnection handling ────────────────────────────────────────────────────
 *   On reconnect, Flutter client should re-emit join_trip with the same tripId.
 *   The server will re-add the socket to the room and send a `trip_rejoined` ack.
 */

const logger = require('../utils/logger');
const { getTrip, getDriverLocation } = require('../services/tripService');
const { socketAuthMiddleware } = require('../middlewares/socketAuth');

/**
 * Register all ride-tracking Socket.IO event handlers.
 * @param {import('socket.io').Server} io
 */
function registerRideSocket(io) {
    // Use a namespace for all ride events to keep concerns separate
    const rideNs = io.of('/ride');

    // Enforce JWT authentication on /ride namespace
    rideNs.use(socketAuthMiddleware);

    rideNs.on('connection', (socket) => {
        logger.info(`[RideSocket] Client connected: ${socket.id}`);

        // ── Join a trip room ─────────────────────────────────────────────────
        socket.on('join_trip', async ({ tripId, role = 'unknown' }) => {
            if (!tripId) {
                socket.emit('error', { message: 'tripId is required to join a trip room' });
                return;
            }

            const room = `trip:${tripId}`;
            socket.join(room);

            logger.info(`[RideSocket] ${socket.id} (role=${role}) joined room: ${room}`);

            // Send acknowledgement with current trip state (for reconnect scenarios)
            try {
                const trip = await getTrip(tripId);
                let driverLocation = null;
                if (trip && trip.driverId) {
                    driverLocation = await getDriverLocation(trip.driverId);
                }

                if (process.env.DEBUG_NAVIGATION === 'true') {
                    logger.info('SOCKET_EMIT', { event: 'trip_joined', tripId, routeVersion: trip ? trip.routeVersion : null });
                }
                socket.emit('trip_joined', {
                    tripId,
                    room,
                    role,
                    currentState: trip
                        ? {
                              status: trip.status,
                              encodedPolyline: trip.encodedPolyline,
                              distanceMeters: trip.distanceMeters,
                              durationSeconds: trip.durationSeconds,
                              routeVersion: trip.routeVersion,
                              trafficDataVersion: trip.trafficDataVersion || 1,
                              trafficSegments: trip.trafficSegments || [],
                              trafficAvailable: trip.trafficAvailable || false,
                              trafficAgeSeconds: Math.round((Date.now() - (trip.lastTrafficRefresh || Date.now())) / 1000),
                              isTrafficStale: Math.round((Date.now() - (trip.lastTrafficRefresh || Date.now())) / 1000) > 900,
                              driverLocation: driverLocation,
                          }
                        : null,
                });
            } catch (err) {
                logger.error(`[RideSocket] Error fetching trip state for join_trip:`, err.message);
                socket.emit('trip_joined', { tripId, room, role, currentState: null });
            }
        });

        // ── Leave a trip room ────────────────────────────────────────────────
        socket.on('leave_trip', ({ tripId }) => {
            if (!tripId) return;
            const room = `trip:${tripId}`;
            socket.leave(room);
            logger.info(`[RideSocket] ${socket.id} left room: ${room}`);
        });

        // ── Heartbeat ping ────────────────────────────────────────────────────
        socket.on('ping', ({ tripId }) => {
            socket.emit('pong', { tripId, serverTime: Date.now() });
        });

        // ── Request current driver location (polling fallback) ────────────────
        socket.on('request_driver_location', async ({ driverId }) => {
            if (!driverId) return;

            try {
                const loc = await getDriverLocation(driverId);
                socket.emit('driver_location_snapshot', {
                    driverId,
                    location: loc,
                    timestamp: Date.now(),
                });
            } catch (err) {
                logger.error(`[RideSocket] Error fetching driver location:`, err.message);
            }
        });

        // ── Disconnect cleanup ────────────────────────────────────────────────
        socket.on('disconnect', (reason) => {
            logger.info(`[RideSocket] Client disconnected: ${socket.id} — reason: ${reason}`);
            // Socket.IO automatically removes the socket from all rooms on disconnect.
            // No manual cleanup needed here unless you track socket→tripId mappings.
        });

        // ── Error handling ────────────────────────────────────────────────────
        socket.on('error', (err) => {
            logger.error(`[RideSocket] Socket error from ${socket.id}:`, err.message);
        });
    });

    logger.info('[RideSocket] Ride namespace /ride registered');
}

module.exports = { registerRideSocket };
