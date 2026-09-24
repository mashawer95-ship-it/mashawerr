/**
 * trackingSocket.js
 * Socket.IO namespace: /tracking
 *
 * This is the main realtime hub for the driver live tracking system.
 * ALL realtime events go through this file — no polling, no HTTP.
 *
 * ── Namespace ────────────────────────────────────────────────────────────────
 *   Flutter connects to: ws://<host>/tracking
 *
 * ── Authentication ───────────────────────────────────────────────────────────
 *   All connections MUST provide a valid JWT in:
 *     socket.auth.token = 'Bearer <jwt>'
 *   Invalid tokens → connection rejected immediately.
 *
 * ── Events: Driver → Server ──────────────────────────────────────────────────
 *   updateDriverLocation   { tripId, lat, lng, heading?, speed? }
 *   joinTrip               { tripId }
 *   endTrip                { tripId }
 *   goOnline               (no payload)
 *   goOffline              (no payload)
 *
 * ── Events: Customer → Server ────────────────────────────────────────────────
 *   subscribeToTrip        { tripId, driverId }
 *   unsubscribeFromTrip    { tripId }
 *
 * ── Events: Server → Client ──────────────────────────────────────────────────
 *   driverLocationUpdated  { d, la, ln, h, t }       ← minimal payload
 *   driverDisconnected     { driverId, tripId, reason, timestamp }
 *   tripEnded              { tripId, driverId, timestamp }
 *   tripJoined             { tripId, driverId, timestamp }
 *   subscribed             { tripId, driverId, hasLocation }
 *   reconnected            { tripId, message }
 *   pong                   { serverTime }
 *   error                  { message }
 */

const { socketAuthMiddleware } = require('../middlewares/socketAuth');
const {
    onDriverConnected,
    onDriverDisconnected,
    processLocationUpdate,
    driverJoinTrip,
    driverEndTrip,
    customerSubscribeToTrip,
    customerUnsubscribeFromTrip,
} = require('../services/trackingService');
const {
    setDriverOnline,
    setDriverOffline,
    getDriverStatus,
    getOnlineDriverCount,
} = require('../redis/trackingRedis');
const { touchRepAppState, setRepAppState } = require('../redis/hrRedis');
const logger = require('../utils/logger');

/** Heartbeat interval: server pings all connected sockets every 30s */
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * Register the /tracking namespace and all event handlers.
 * Called once from app.js after the Socket.IO server is created.
 *
 * @param {import('socket.io').Server} io
 */
function registerTrackingSocket(io) {
    const nsp = io.of('/tracking');

    // ── Apply JWT authentication to ALL connections in this namespace ─────────
    nsp.use(socketAuthMiddleware);

    // ── Connection handler ────────────────────────────────────────────────────
    nsp.on('connection', async (socket) => {
        const user = socket.user; // populated by socketAuthMiddleware

        // ── Driver lifecycle ─────────────────────────────────────────────────

        /**
         * Driver: go online (called when driver opens the app and is ready to receive trips).
         */
        socket.on('goOnline', async () => {
            await setDriverOnline(user.id);
            await onDriverConnected(socket, nsp);
            socket.emit('online', { driverId: user.id, timestamp: Date.now() });
            logger.info(`[Tracking] Driver ${user.id} went ONLINE`);
        });

        /**
         * Driver: go offline (called when driver explicitly logs out of driver mode).
         */
        socket.on('goOffline', async () => {
            await setDriverOffline(user.id);
            socket.emit('offline', { driverId: user.id, timestamp: Date.now() });
            logger.info(`[Tracking] Driver ${user.id} went OFFLINE`);
        });

        // ── HR Real-time Events (Driver App) ──────────────────────────────────
        socket.on('hr:heartbeat', async () => {
            await touchRepAppState(user.id);
            socket.emit('hr:heartbeat_ack', { timestamp: Date.now() });
        });

        socket.on('hr:app_opened', async () => {
            await setRepAppState(user.id, 'open');
            logger.info(`[Tracking] HR app_opened event received from ${user.id}`);
        });

        socket.on('hr:app_closing', async () => {
            await setRepAppState(user.id, 'closed');
            logger.info(`[Tracking] HR app_closing event received from ${user.id}`);
        });

        // ── Trip management ──────────────────────────────────────────────────

        /**
         * Driver: join a trip room to start broadcasting location.
         * Payload: { tripId: string }
         */
        socket.on('joinTrip', async ({ tripId } = {}) => {
            if (!tripId) {
                socket.emit('error', { message: 'joinTrip requires tripId' });
                return;
            }
            try {
                await driverJoinTrip(socket, tripId);
            } catch (err) {
                logger.error(`[Tracking] joinTrip error for driver ${user.id}:`, err.message);
                socket.emit('error', { message: 'Failed to join trip' });
            }
        });

        /**
         * Driver: end the trip.
         * Broadcasts tripEnded to all customers in the trip room.
         * Payload: { tripId: string }
         */
        socket.on('endTrip', async ({ tripId } = {}) => {
            if (!tripId) {
                socket.emit('error', { message: 'endTrip requires tripId' });
                return;
            }
            try {
                await driverEndTrip(socket, nsp, tripId);
            } catch (err) {
                logger.error(`[Tracking] endTrip error for driver ${user.id}:`, err.message);
                socket.emit('error', { message: 'Failed to end trip' });
            }
        });

        // ── Live location update ─────────────────────────────────────────────

        /**
         * Driver: send a live GPS update.
         * This is the HOT PATH — called every 5-10 seconds per driver.
         *
         * Payload: { tripId, lat, lng, heading?, speed? }
         * Response: server broadcasts 'driverLocationUpdated' to trip room
         */
        socket.on('updateDriverLocation', async (payload) => {
            if (!payload || typeof payload !== 'object') {
                socket.emit('error', { message: 'Invalid payload' });
                return;
            }

            try {
                const result = await processLocationUpdate(socket, nsp, payload);

                // If client requested forceReroute or reported off-route, recalculate route immediately
                if (payload.forceReroute === true || payload.isOffRoute === true) {
                    try {
                        const { processLocationUpdate: tripReroute } = require('../services/tripService');
                        tripReroute(
                            payload.tripId,
                            user.id,
                            {
                                lat: Number(payload.lat),
                                lng: Number(payload.lng),
                                speed: payload.speed != null ? Number(payload.speed) : null
                            },
                            payload.heading != null ? Number(payload.heading) : null,
                            io,
                            { forceReroute: true }
                        ).catch(err => logger.error(`[Tracking] Socket forceReroute error: ${err.message}`));
                    } catch (rerouteErr) {
                        logger.error(`[Tracking] Error triggering reroute from socket: ${rerouteErr.message}`);
                    }
                }

                // Send lightweight ack back to driver (optional — can disable to save bandwidth)
                if (process.env.SEND_LOCATION_ACK === 'true') {
                    socket.emit('locationAck', {
                        broadcasted: result.broadcasted,
                        reason: result.reason || null,
                        ts: Date.now(),
                    });
                }
            } catch (err) {
                logger.error(`[Tracking] updateDriverLocation error for ${user.id}:`, err.message);
                socket.emit('error', { message: 'Location update failed' });
            }
        });

        /**
         * Driver: explicit request to recalculate route (reroute)
         */
        socket.on('requestReroute', async (payload) => {
            if (!payload || !payload.tripId || payload.lat == null || payload.lng == null) {
                socket.emit('error', { message: 'requestReroute requires tripId, lat, and lng' });
                return;
            }
            try {
                const { processLocationUpdate: tripReroute } = require('../services/tripService');
                const result = await tripReroute(
                    payload.tripId,
                    user.id,
                    {
                        lat: Number(payload.lat),
                        lng: Number(payload.lng),
                        speed: payload.speed != null ? Number(payload.speed) : null
                    },
                    payload.heading != null ? Number(payload.heading) : null,
                    io,
                    { forceReroute: true }
                );
                socket.emit('rerouteResult', { success: true, rerouted: result.rerouted, data: result });
            } catch (err) {
                logger.error(`[Tracking] requestReroute error for ${user.id}:`, err.message);
                socket.emit('rerouteResult', { success: false, error: err.message });
            }
        });

        // ── Customer subscription ────────────────────────────────────────────

        /**
         * Customer: subscribe to a driver's live location within a trip.
         * Immediately receives last known driver position (snapshot).
         *
         * Payload: { tripId: string, driverId: string }
         */
        const handleSubscribeToTrip = async ({ tripId, driverId } = {}) => {
            if (!tripId) {
                socket.emit('error', { message: 'subscribeToTrip requires tripId' });
                return;
            }
            try {
                if (!driverId) {
                    // Flutter client currently sends {tripId, role} and forgets driverId.
                    // Let's fetch it from the database instead of failing.
                    const { getTrip } = require('../services/tripService');
                    const trip = await getTrip(tripId);
                    if (trip && trip.driverId) {
                        driverId = trip.driverId;
                    }
                }
                
                await customerSubscribeToTrip(socket, tripId, driverId);
            } catch (err) {
                logger.error(`[Tracking] subscribeToTrip error:`, err.message);
                socket.emit('error', { message: 'Failed to subscribe to trip' });
            }
        };

        socket.on('subscribeToTrip', handleSubscribeToTrip);
        socket.on('join_trip', handleSubscribeToTrip); // Alias for Flutter Client

        /**
         * Phase 2.3: Client ACK Listener
         * Listen for 'route.received' from the Flutter app to confirm delivery.
         */
        socket.on('route.received', (payload) => {
            const { tripId, version, checksum, clientAckTime } = payload || {};
            if (tripId) {
                console.log(`[CLIENT_ACK_RECEIVED] tripId=${tripId} version=${version} checksum=${checksum} clientTime=${clientAckTime}`);
                metrics.increment('routeClientAcks');
            }
        });

        /**
         * Customer: unsubscribe from trip tracking (e.g., navigated away).
         * Payload: { tripId: string }
         */
        socket.on('unsubscribeFromTrip', ({ tripId } = {}) => {
            if (!tripId) return;
            customerUnsubscribeFromTrip(socket, tripId);
        });

        // ── Heartbeat / Ping ─────────────────────────────────────────────────

        /**
         * Client sends ping → server responds with pong + serverTime.
         * Used by Flutter to detect connection health without HTTP.
         */
        socket.on('ping', () => {
            socket.emit('pong', { serverTime: Date.now() });
        });

        // ── Disconnect ───────────────────────────────────────────────────────

        socket.on('disconnect', async (reason) => {
            try {
                await onDriverDisconnected(socket, nsp, reason);
            } catch (err) {
                logger.error(`[Tracking] disconnect handler error:`, err.message);
            }
        });

        // ── Socket error ─────────────────────────────────────────────────────

        socket.on('error', (err) => {
            logger.error(`[Tracking] Socket error from ${socket.id} (user: ${user?.id}):`, err.message);
        });

        // ── Log successful connection ─────────────────────────────────────────
        const onlineCount = await getOnlineDriverCount();
        logger.info(`[Tracking] Connected: ${socket.id} user=${user.id} | online drivers: ${onlineCount}`);
    });

    // ── Server-side heartbeat broadcast ──────────────────────────────────────
    // Sends a server-time ping to all connected clients every 30s.
    // Flutter can use this to measure latency and detect stale connections.
    setInterval(async () => {
        const count = nsp.sockets.size;
        if (count === 0) return;

        nsp.emit('serverHeartbeat', {
            serverTime: Date.now(),
            connectedClients: count,
        });
    }, HEARTBEAT_INTERVAL_MS);

    logger.info('[Tracking] /tracking namespace registered');
}

module.exports = { registerTrackingSocket };
