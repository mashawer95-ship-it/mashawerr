/**
 * driver.js  (routes layer)
 * Express router for driver-specific endpoints.
 *
 * Route map:
 *   POST  /api/driver/location              → Update driver GPS location
 *   GET   /api/driver/:driverId/location    → Get driver's last known location
 */

const router = require('express').Router();
const { verifyToken } = require('../middlewares/verifytoken');
const { locationUpdateLimiter, tripApiLimiter } = require('../middlewares/rateLimiter');
const { validateLocation } = require('../middlewares/validateRide');
const {
    updateDriverLocation,
    getDriverLocationHandler,
} = require('../Controllers/tripController');

/**
 * @route   POST /api/driver/location
 * @desc    Receive live GPS location from driver app (called every 5-10 seconds)
 *          - Saves location to Redis
 *          - Checks if driver deviated from route (>50m)
 *          - If off-route and cooldown expired: recalculates route, emits routeUpdated
 *          - Always emits driverLocationUpdated to trip room
 * @access  Private (JWT required)
 * @body    { tripId: string, lat: number, lng: number }
 */
router.post('/location', verifyToken, locationUpdateLimiter, validateLocation, updateDriverLocation);

/**
 * @route   GET /api/driver/:driverId/location
 * @desc    Get last known GPS position of a driver
 * @access  Private (JWT required)
 */
router.get('/:driverId/location', verifyToken, tripApiLimiter, getDriverLocationHandler);

module.exports = router;
