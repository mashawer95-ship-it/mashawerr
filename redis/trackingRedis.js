/**
 * trackingRedis.js
 * All Redis operations for the live driver tracking module.
 *
 * Key schema (prefix: trk:)
 * ─────────────────────────────────────────────────────────────────────────────
 *  trk:driver:{driverId}:loc      → latest GPS snapshot  (TTL: 2 min)
 *  trk:driver:{driverId}:status   → 'online' | 'offline' (TTL: 2 min, refreshed on each update)
 *  trk:driver:{driverId}:trip     → tripId the driver is currently serving
 *  trk:trip:{tripId}:drivers      → Set of driverIds in this trip
 *  trk:online:drivers             → HSET of driverId → last_seen_ms (all online drivers)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * TTL strategy:
 *  - Location TTL = 2 minutes  → auto-expire stale drivers with no updates
 *  - Trip TTL = 12 hours       → trip can span a long time
 *  - Online heartbeat refreshed on every location update
 */

const { redisGet, redisSet, redisDel, getRedisClient } = require('../config/redis');
const logger = require('../utils/logger');

// ── TTL constants ────────────────────────────────────────────────────────────
const DRIVER_LOC_TTL   = 120;   // 2 minutes
const DRIVER_STATUS_TTL = 120;  // 2 minutes (refreshed each update = alive detection)
const TRIP_TTL         = 43200; // 12 hours

// ── Key builders ─────────────────────────────────────────────────────────────
const k = {
    driverLoc:    (id) => `trk:driver:${id}:loc`,
    driverStatus: (id) => `trk:driver:${id}:status`,
    driverTrip:   (id) => `trk:driver:${id}:trip`,
    tripDrivers:  (id) => `trk:trip:${id}:drivers`,
    onlineSet:          `trk:online:drivers`,
};

// ─────────────────────────────────────────────────────────────────────────────
//  DRIVER LOCATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Save/update driver GPS snapshot.
 * @param {string} driverId
 * @param {{ lat: number, lng: number, heading?: number, speed?: number, timestamp: number }} loc
 */
async function setDriverLocation(driverId, loc) {
    await redisSet(k.driverLoc(driverId), loc, DRIVER_LOC_TTL);
}

/**
 * Get last known GPS snapshot for a driver.
 * @param {string} driverId
 * @returns {object|null}
 */
async function getDriverLocation(driverId) {
    return redisGet(k.driverLoc(driverId));
}

// ─────────────────────────────────────────────────────────────────────────────
//  DRIVER STATUS (online/offline)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark driver as online. Refreshes TTL automatically.
 * @param {string} driverId
 */
async function setDriverOnline(driverId) {
    await redisSet(k.driverStatus(driverId), 'online', DRIVER_STATUS_TTL);

    // Also add to the global online drivers hash (for admin dashboards / queries)
    const redis = getRedisClient();
    if (redis) {
        try {
            await redis.hset(k.onlineSet, driverId, Date.now().toString());
        } catch (err) {
            logger.error('[TrackingRedis] hset online set error:', err.message);
        }
    }
}

/**
 * Mark driver as offline. Removes from online set.
 * @param {string} driverId
 */
async function setDriverOffline(driverId) {
    await redisSet(k.driverStatus(driverId), 'offline', DRIVER_STATUS_TTL);

    const redis = getRedisClient();
    if (redis) {
        try {
            await redis.hdel(k.onlineSet, driverId);
        } catch (err) {
            logger.error('[TrackingRedis] hdel online set error:', err.message);
        }
    }
}

/**
 * Get driver online/offline status.
 * @param {string} driverId
 * @returns {'online'|'offline'|'unknown'}
 */
async function getDriverStatus(driverId) {
    const status = await redisGet(k.driverStatus(driverId));
    return status || 'unknown';
}

/**
 * Get count of currently online drivers.
 * @returns {number}
 */
async function getOnlineDriverCount() {
    const redis = getRedisClient();
    if (!redis) return 0;
    try {
        return await redis.hlen(k.onlineSet);
    } catch {
        return 0;
    }
}

/**
 * Get all currently online driver IDs.
 * @returns {string[]}
 */
async function getOnlineDriverIds() {
    const redis = getRedisClient();
    if (!redis) return [];
    try {
        const hash = await redis.hgetall(k.onlineSet);
        return hash ? Object.keys(hash) : [];
    } catch {
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DRIVER ↔ TRIP ASSOCIATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Associate a driver with a trip room.
 * @param {string} driverId
 * @param {string} tripId
 */
async function setDriverTrip(driverId, tripId) {
    await redisSet(k.driverTrip(driverId), tripId, TRIP_TTL);

    // Add driver to trip's driver set
    const redis = getRedisClient();
    if (redis) {
        try {
            await redis.sadd(k.tripDrivers(tripId), driverId);
            await redis.expire(k.tripDrivers(tripId), TRIP_TTL);
        } catch (err) {
            logger.error('[TrackingRedis] sadd trip drivers error:', err.message);
        }
    }
}

/**
 * Get the tripId currently assigned to a driver.
 * @param {string} driverId
 * @returns {string|null}
 */
async function getDriverTrip(driverId) {
    return redisGet(k.driverTrip(driverId));
}

/**
 * Remove driver ↔ trip association on trip end.
 * @param {string} driverId
 * @param {string} tripId
 */
async function clearDriverTrip(driverId, tripId) {
    await redisDel(k.driverTrip(driverId));

    const redis = getRedisClient();
    if (redis && tripId) {
        try {
            await redis.srem(k.tripDrivers(tripId), driverId);
        } catch (err) {
            logger.error('[TrackingRedis] srem trip drivers error:', err.message);
        }
    }
}

/**
 * Get all driver IDs in a trip.
 * @param {string} tripId
 * @returns {string[]}
 */
async function getTripDriverIds(tripId) {
    const redis = getRedisClient();
    if (!redis) return [];
    try {
        return await redis.smembers(k.tripDrivers(tripId));
    } catch {
        return [];
    }
}

/**
 * Full cleanup of a trip from Redis (called when trip ends).
 * @param {string} tripId
 */
async function cleanupTrip(tripId) {
    await redisDel(k.tripDrivers(tripId));
}

// ─────────────────────────────────────────────────────────────────────────────
//  DRIVER FULL CLEANUP (disconnect / logout)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove all Redis keys for a driver on logout/disconnect.
 * @param {string} driverId
 */
async function cleanupDriver(driverId) {
    await redisDel(
        k.driverLoc(driverId),
        k.driverStatus(driverId),
        k.driverTrip(driverId),
    );

    const redis = getRedisClient();
    if (redis) {
        try {
            await redis.hdel(k.onlineSet, driverId);
        } catch (err) {
            logger.error('[TrackingRedis] cleanup driver error:', err.message);
        }
    }
}

module.exports = {
    // Location
    setDriverLocation,
    getDriverLocation,
    // Status
    setDriverOnline,
    setDriverOffline,
    getDriverStatus,
    getOnlineDriverCount,
    getOnlineDriverIds,
    // Trip association
    setDriverTrip,
    getDriverTrip,
    clearDriverTrip,
    getTripDriverIds,
    cleanupTrip,
    // Full cleanup
    cleanupDriver,
    // Key builders (for testing)
    _keys: k,
};
