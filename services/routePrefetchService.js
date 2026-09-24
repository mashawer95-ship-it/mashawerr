/**
 * routePrefetchService.js
 * Background route prefetching service.
 * Pre-calculates and caches route geometry & active route as soon as a driver is assigned.
 * Ensures 0 Google API calls when representative opens the map screen.
 */

const { buildRouteCacheKey } = require('../utils/routeCacheKey');
const { memoryRouteCache } = require('./memoryRouteCache');
const { callGoogleRoutesAPI } = require('./googleRoutesService');
const { redisGet, redisSet } = require('../config/redis');
const metrics = require('../utils/metrics');
const logger = require('../utils/logger');
const { orderEvents } = require('./orderEvents');

/**
 * Prefetch route for assigned driver in background.
 * @param {string} orderId - Order / Trip ID
 * @param {number} driverLat
 * @param {number} driverLng
 * @param {number} pickupLat
 * @param {number} pickupLng
 * @param {object} [options]
 */
async function prefetchRouteForDriver(orderId, driverLat, driverLng, pickupLat, pickupLng, options = {}) {
    const tripId = orderId;

    try {
        logger.info(`[Prefetch] Starting background prefetch for tripId=${tripId}`);

        const params = {
            originLat:  driverLat,
            originLng:  driverLng,
            destLat:    pickupLat,
            destLng:    pickupLng,
            travelMode: options.travelMode || 'DRIVE',
            vehicleType: options.vehicleType || 'CAR',
            language:   options.language || 'ar',
        };

        const cacheKey = buildRouteCacheKey(params);

        // Check Layer 1: Memory LRU Cache
        const memHit = memoryRouteCache.get(cacheKey);
        if (memHit) {
            logger.info(`[Prefetch] Already present in memory cache — skipping API call for ${tripId}`);
            metrics.increment('prefetch_memory_skip');
            return;
        }

        // Check Layer 2: Redis Geometry Cache
        const redisHit = await redisGet(cacheKey);
        if (redisHit) {
            const parsed = typeof redisHit === 'string' ? JSON.parse(redisHit) : redisHit;
            memoryRouteCache.set(cacheKey, parsed);
            logger.info(`[Prefetch] Already present in Redis — warmed memory cache for ${tripId}`);
            metrics.increment('prefetch_redis_skip');
            return;
        }

        // Layer 3: Call Google Routes API in background
        const routeData = await callGoogleRoutesAPI(params);
        const version = 1;

        // Save to Layer 2: Redis Geometry Cache
        const geomTtl = parseInt(process.env.ROUTE_CACHE_GEOMETRY_TTL_SEC || '3600', 10);
        await redisSet(cacheKey, routeData, geomTtl);

        // Save to Layer 1: Memory LRU Cache
        memoryRouteCache.set(cacheKey, routeData);

        // Save to Active Route Cache (`active_route:${tripId}`)
        const activeTtl = parseInt(process.env.ACTIVE_ROUTE_CACHE_TTL_SEC || '7200', 10);
        const activePayload = {
            encodedPolyline: routeData.encodedPolyline,
            distanceMeters:  routeData.distanceMeters,
            durationSeconds: routeData.durationSeconds,
            routeToken:      routeData.routeToken,
            legs:            routeData.legs,
            routeVersion:    version,
            destination:     { lat: pickupLat, lng: pickupLng },
            lastOriginLat:   driverLat,
            lastOriginLng:   driverLng,
            prefetchedAt:    Date.now(),
        };

        await redisSet(`active_route:${tripId}`, activePayload, activeTtl);

        metrics.increment('prefetch_google_calls');
        logger.info(`[Prefetch] Complete for tripId=${tripId} — active route cached before driver opens app`);

    } catch (err) {
        logger.warn(`[Prefetch] Failed for tripId=${tripId}: ${err.message}`);
        metrics.increment('prefetch_failures');
    }
}

// Bind to driver assignment event
orderEvents.on('driver_assigned', ({ orderId, driverId, driverLat, driverLng, pickupLat, pickupLng, options }) => {
    setImmediate(() => prefetchRouteForDriver(orderId, driverLat, driverLng, pickupLat, pickupLng, options));
});

module.exports = {
    prefetchRouteForDriver,
};
