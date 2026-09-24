/**
 * tripController.js
 * HTTP request handlers for Mashawerr ride-tracking REST API (Route Pipeline v3).
 */

const asyncHandler = require('express-async-handler');
const { startTrip, endTrip, processLocationUpdate, getTrip, getDriverLocation } = require('../services/tripService');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');

// ── Start Trip ───────────────────────────────────────────────────────────────

/**
 * POST /api/trip/start
 * Body: { tripId, origin: { lat, lng }, destination: { lat, lng }, options? }
 */
const startTripHandler = asyncHandler(async (req, res) => {
    const driverId = req.user?.id || req.user?._id?.toString();
    const { tripId, origin, destination, options } = req.body;

    if (!driverId) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    if (!tripId || !origin || !destination) {
        return res.status(400).json({ success: false, message: 'tripId, origin, and destination are required' });
    }

    logger.info(`[TripController] START trip=${tripId} driver=${driverId}`);

    try {
        const io = req.app.get('io');
        const trip = await startTrip(tripId, driverId, origin, destination, { ...(options || {}), io, req });

        if (io) {
            io.to(`trip:${tripId}`).emit('tripStarted', { tripId, driverId, routeVersion: trip.routeVersion });
        }

        res.status(200).json({
            success: true,
            data: trip,
        });
    } catch (err) {
        if (err.message.includes('in progress')) {
            return res.status(429).json({ success: false, error: err.message });
        }
        throw err;
    }
});

// ── End Trip ─────────────────────────────────────────────────────────────────

/**
 * POST /api/trip/end
 * Body: { tripId }
 */
const endTripHandler = asyncHandler(async (req, res) => {
    const driverId = req.user?.id || req.user?._id?.toString();
    const { tripId } = req.body;

    if (!driverId) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    if (!tripId) {
        return res.status(400).json({ success: false, message: 'tripId is required' });
    }

    const io = req.app.get('io');
    logger.info(`[TripController] END trip=${tripId} driver=${driverId}`);

    const trip = await endTrip(tripId, driverId, io);

    res.status(200).json({
        success: true,
        message: 'Trip completed successfully',
        data: trip,
    });
});

// ── Driver Location Update ───────────────────────────────────────────────────

/**
 * POST /api/driver/location
 * Body: { tripId, lat, lng, heading? }
 */
const updateDriverLocation = asyncHandler(async (req, res) => {
    const driverId = req.user?.id || req.user?._id?.toString();
    const { tripId, lat, lng, heading, speed, forceReroute } = req.body;

    if (!driverId) {
        return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const location = {
        lat: Number(lat),
        lng: Number(lng),
        heading: heading != null ? Number(heading) : null,
        speed: speed != null ? Number(speed) : null,
    };
    const io = req.app.get('io');

    const { setDriverLocation, setDriverOnline } = require('../redis/trackingRedis');
    setDriverLocation(driverId, { ...location, timestamp: Date.now() }).catch(() => {});
    setDriverOnline(driverId).catch(() => {});

    try {
        const { User } = require('../middlewares/User');
        User.findByIdAndUpdate(driverId, {
            'lastLocation.lat': location.lat,
            'lastLocation.lng': location.lng,
            'lastLocation.updatedAt': new Date(),
        }).exec();
    } catch (_) {}

    const result = await processLocationUpdate(tripId, driverId, location, heading, io, {
        forceReroute: forceReroute === true || forceReroute === 'true',
    });

    res.status(200).json({
        success: true,
        message: 'Location updated',
        data: result,
    });
});

// ── Get Trip ─────────────────────────────────────────────────────────────────

/**
 * GET /api/trip/:tripId
 */
const getTripHandler = asyncHandler(async (req, res) => {
    const { tripId } = req.params;
    const trip = await getTrip(tripId);

    if (!trip) {
        return res.status(404).json({ success: false, message: `Trip ${tripId} not found` });
    }

    res.status(200).json({ success: true, data: trip });
});

// ── Get Driver Location ───────────────────────────────────────────────────────

/**
 * GET /api/driver/:driverId/location
 */
const getDriverLocationHandler = asyncHandler(async (req, res) => {
    const { driverId } = req.params;
    const loc = await getDriverLocation(driverId);

    if (!loc) {
        return res.status(404).json({ success: false, message: `No location found for driver ${driverId}` });
    }

    res.status(200).json({ success: true, data: loc });
});

// ── Route Metrics Endpoint ───────────────────────────────────────────────────

/**
 * GET /admin/route-metrics
 */
const getRouteMetricsHandler = asyncHandler(async (req, res) => {
    const aggregate = await metrics.getAggregateMetrics();
    res.status(200).json(aggregate);
});

module.exports = {
    startTripHandler,
    endTripHandler,
    updateDriverLocation,
    getTripHandler,
    getDriverLocationHandler,
    getRouteMetricsHandler,
};
