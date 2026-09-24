/**
 * trackingController.js
 * HTTP REST endpoints for the tracking system.
 *
 * These are admin/status endpoints — NOT used for live location streaming.
 * Live location is handled 100% over Socket.IO (/tracking namespace).
 *
 * Endpoints:
 *   GET /api/tracking/driver/:driverId/location  → last known GPS position
 *   GET /api/tracking/driver/:driverId/status    → online/offline
 *   GET /api/tracking/stats                      → how many online drivers
 *   GET /api/tracking/trip/:tripId/drivers       → driver IDs in a trip
 */

const asyncHandler = require('express-async-handler');
const {
    getDriverLocation,
    getDriverStatus,
    getOnlineDriverCount,
    getOnlineDriverIds,
    getTripDriverIds,
} = require('../redis/trackingRedis');
const logger = require('../utils/logger');

/**
 * GET /api/tracking/driver/:driverId/location
 * Returns last known GPS location stored in Redis.
 * Useful for: customer app initial map load before socket connects.
 */
const getDriverLocationHTTP = asyncHandler(async (req, res) => {
    const { driverId } = req.params;
    const loc = await getDriverLocation(driverId);

    if (!loc) {
        return res.status(404).json({
            success: false,
            message: `No location data found for driver ${driverId}`,
        });
    }

    res.json({ success: true, data: loc });
});

/**
 * GET /api/tracking/driver/:driverId/status
 * Returns online/offline status from Redis.
 */
const getDriverStatusHTTP = asyncHandler(async (req, res) => {
    const { driverId } = req.params;
    const status = await getDriverStatus(driverId);
    res.json({ success: true, data: { driverId, status } });
});

/**
 * GET /api/tracking/stats
 * System-level stats: how many drivers are currently online.
 * Used for admin dashboards.
 */
const getTrackingStats = asyncHandler(async (req, res) => {
    const onlineCount = await getOnlineDriverCount();
    const onlineIds = await getOnlineDriverIds();

    res.json({
        success: true,
        data: {
            onlineDrivers: onlineCount,
            driverIds: onlineIds,
            timestamp: new Date().toISOString(),
        },
    });
});

/**
 * GET /api/tracking/trip/:tripId/drivers
 * Returns all driver IDs currently associated with a trip.
 */
const getTripDriversHTTP = asyncHandler(async (req, res) => {
    const { tripId } = req.params;
    const driverIds = await getTripDriverIds(tripId);

    res.json({
        success: true,
        data: { tripId, driverIds },
    });
});

module.exports = {
    getDriverLocationHTTP,
    getDriverStatusHTTP,
    getTrackingStats,
    getTripDriversHTTP,
};
