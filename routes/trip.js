/**
 * trip.js (routes layer)
 * Express router for Mashawerr ride-tracking REST endpoints.
 */

const router = require('express').Router();
const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');
const { tripApiLimiter } = require('../middlewares/rateLimiter');
const { validateStartTrip } = require('../middlewares/validateRide');
const {
    startTripHandler,
    endTripHandler,
    getTripHandler,
    updateDriverLocation,
    getDriverLocationHandler,
    getRouteMetricsHandler,
} = require('../Controllers/tripController');

// ── Trip Management Endpoints ────────────────────────────────────────────────

/**
 * @route   POST /api/trip/start
 * @desc    Start a new trip and calculate/fetch route via Pipeline v3
 * @access  Private (JWT required)
 */
router.post('/start', verifyToken, tripApiLimiter, validateStartTrip, startTripHandler);

/**
 * @route   POST /api/trip/end
 * @desc    End active trip and cleanup active route cache
 * @access  Private (JWT required)
 */
router.post('/end', verifyToken, tripApiLimiter, endTripHandler);

/**
 * @route   POST /api/trip/location
 * @desc    Update driver GPS location and check for rerouting
 * @access  Private (JWT required)
 */
router.post('/location', verifyToken, updateDriverLocation);

/**
 * @route   GET /api/trip/metrics
 * @desc    Get aggregate Google Routes cost optimization metrics
 * @access  Admin only
 */
router.get('/metrics', verifyTokenAndAdmin, getRouteMetricsHandler);

/**
 * @route   GET /api/trip/:tripId
 * @desc    Get trip state and polyline
 * @access  Private (JWT required)
 */
router.get('/:tripId', verifyToken, tripApiLimiter, getTripHandler);

module.exports = router;
