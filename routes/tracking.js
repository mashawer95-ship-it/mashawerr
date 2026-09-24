/**
 * tracking.js  (routes layer)
 * Express router for tracking status/admin REST endpoints.
 *
 * Note: Live tracking is handled over Socket.IO at /tracking namespace.
 * These HTTP endpoints serve as fallback/admin/snapshot queries.
 *
 * All routes require JWT authentication.
 */

const router = require('express').Router();
const { verifyToken } = require('../middlewares/verifytoken');
const { tripApiLimiter } = require('../middlewares/rateLimiter');
const {
    getDriverLocationHTTP,
    getDriverStatusHTTP,
    getTrackingStats,
    getTripDriversHTTP,
} = require('../Controllers/trackingController');

/**
 * @route   GET /api/tracking/driver/:driverId/location
 * @desc    Get driver's last known GPS location from Redis
 * @access  Private (JWT)
 */
router.get('/driver/:driverId/location', verifyToken, tripApiLimiter, getDriverLocationHTTP);

/**
 * @route   GET /api/tracking/driver/:driverId/status
 * @desc    Get driver online/offline status
 * @access  Private (JWT)
 */
router.get('/driver/:driverId/status', verifyToken, tripApiLimiter, getDriverStatusHTTP);

/**
 * @route   GET /api/tracking/stats
 * @desc    Get system tracking stats (online driver count, IDs)
 * @access  Private (JWT, admin recommended)
 */
router.get('/stats', verifyToken, tripApiLimiter, getTrackingStats);

/**
 * @route   GET /api/tracking/trip/:tripId/drivers
 * @desc    Get all driver IDs associated with a trip
 * @access  Private (JWT)
 */
router.get('/trip/:tripId/drivers', verifyToken, tripApiLimiter, getTripDriversHTTP);

module.exports = router;
