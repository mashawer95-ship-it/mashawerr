/**
 * offRouteDetector.js
 * Off-Route detection and cooldown tracking.
 *
 * Rules:
 *  1. Distance < OFF_ROUTE_THRESHOLD_M (40m) → No off-route deviation.
 *  2. Distance > OFF_ROUTE_IMMEDIATE_M (150m) → Immediate reroute (bypasses cooldown).
 *  3. 40m <= Distance <= 150m → Normal off-route. Subject to REROUTE_COOLDOWN_SEC (90s).
 */

const { distanceFromPolyline, computeBearing } = require('./polyline');
const logger = require('./logger');
const { redisSet, redisGet, redisDel } = require('../config/redis');

const OFF_ROUTE_THRESHOLD_M = parseInt(process.env.OFF_ROUTE_THRESHOLD_M || '35', 10);
const OFF_ROUTE_IMMEDIATE_M = parseInt(process.env.OFF_ROUTE_IMMEDIATE_M || '100', 10);
const REROUTE_COOLDOWN_SEC = parseInt(process.env.REROUTE_COOLDOWN_SEC || '15', 10);

const cooldownKey = (tripId) => `reroute_cooldown:${tripId}`;

/**
 * Check whether driver position deviates from polyline.
 * @param {string} tripId
 * @param {{ lat: number, lng: number, heading?: number, speed?: number }} driverLocation
 * @param {{ lat: number, lng: number }[]} routePoints
 * @returns {{ isOffRoute: boolean, isImmediate: boolean, distanceFromRoute: number, closestIndex: number }}
 */
function checkOffRoute(tripId, driverLocation, routePoints) {
    if (!routePoints || routePoints.length === 0) {
        logger.warn(`[OffRoute] Trip ${tripId}: empty route points — skipping check`);
        return { isOffRoute: false, isImmediate: false, distanceFromRoute: 0, closestIndex: -1 };
    }

    const { distance: distanceFromRoute, closestSegment, closestIndex } = distanceFromPolyline(driverLocation, routePoints);
    let isOffRoute = distanceFromRoute > OFF_ROUTE_THRESHOLD_M;

    let headingDiff = null;
    if (!isOffRoute && closestSegment && driverLocation.heading != null) {
        const segmentBearing = computeBearing(closestSegment.a, closestSegment.b);
        headingDiff = Math.abs((driverLocation.heading - segmentBearing + 540) % 360 - 180);

        // Heading difference > 90 deg while moving indicates wrong direction
        if (headingDiff > 90 && (driverLocation.speed > 0 || driverLocation.speed == null)) {
            isOffRoute = true;
            logger.debug(`[OffRoute] Trip ${tripId}: Wrong direction detected. Diff=${Math.round(headingDiff)}°`);
        }
    }

    const isImmediate = distanceFromRoute > OFF_ROUTE_IMMEDIATE_M;

    logger.debug(
        `[OffRoute] Trip ${tripId}: distance=${distanceFromRoute.toFixed(1)}m, threshold=${OFF_ROUTE_THRESHOLD_M}m, immediateThreshold=${OFF_ROUTE_IMMEDIATE_M}m, offRoute=${isOffRoute}, immediate=${isImmediate}`
    );

    return { isOffRoute, isImmediate, distanceFromRoute, closestIndex };
}

/**
 * Check if rerouting cooldown is active for tripId.
 * @param {string} tripId
 * @returns {Promise<boolean>}
 */
async function isCooldownActive(tripId) {
    const val = await redisGet(cooldownKey(tripId));
    return val !== null && val !== undefined;
}

/**
 * Mark trip as rerouted and trigger cooldown timer.
 * @param {string} tripId
 */
async function markRerouted(tripId) {
    await redisSet(cooldownKey(tripId), '1', REROUTE_COOLDOWN_SEC);
    logger.info(`[OffRoute] Trip ${tripId}: reroute cooldown activated for ${REROUTE_COOLDOWN_SEC}s`);
}

/**
 * Clear cooldown state when trip ends or resets.
 * @param {string} tripId
 */
async function clearTripState(tripId) {
    await redisDel(cooldownKey(tripId));
}

module.exports = {
    checkOffRoute,
    isCooldownActive,
    markRerouted,
    clearTripState,
    OFF_ROUTE_THRESHOLD_M,
    OFF_ROUTE_IMMEDIATE_M,
    REROUTE_COOLDOWN_SEC,
};
