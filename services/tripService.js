/**
 * tripService.js
 * Core business logic for Mashawerr Route Pipeline v3.
 * Includes Distributed Locking, Multi-layer Caching, Drift Checking, Immediate Rerouting, and Trip End.
 */

const { getRedisClient, redisGet, redisSet, redisDel } = require('../config/redis');
const { callGoogleRoutesAPI } = require('./googleRoutesService');
const { buildRouteCacheKey } = require('../utils/routeCacheKey');
const { memoryRouteCache, getRouteFromAllLayers } = require('./memoryRouteCache');
const { checkOffRoute, isCooldownActive, markRerouted, clearTripState } = require('../utils/offRouteDetector');
const { haversineDistance, encodePolyline, decodePolyline } = require('../utils/polyline');
const { broadcastRoute } = require('./BroadcastService');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { Trip } = require('../models/Trip');
const { resolveOrderIds } = require('../utils/orderIdResolver');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function buildRouteParams(origin, destination, options = {}) {
    return {
        originLat: origin.lat,
        originLng: origin.lng,
        destLat: destination.lat,
        destLng: destination.lng,
        heading: options.heading !== undefined ? options.heading : (origin.heading !== undefined ? origin.heading : null),
        speed: options.speed !== undefined ? options.speed : (origin.speed !== undefined ? origin.speed : null),
        travelMode: options.travelMode || 'DRIVE',
        routingPreference: options.routingPreference || 'TRAFFIC_AWARE',
        vehicleType: options.vehicleType || 'CAR',
        avoidTolls: options.avoidTolls || false,
        avoidHighways: options.avoidHighways || false,
        language: options.language || 'ar',
        intermediates: options.intermediates || [],
        optimizeWaypointOrder: options.optimizeWaypointOrder !== false,
    };
}

// ── 1. Start Trip Pipeline v3 ──────────────────────────────────────────────────

/**
 * Start trip and retrieve route via 5-Step Pipeline v3.
 * @param {string} tripId
 * @param {string} driverId
 * @param {{ lat: number, lng: number }} origin
 * @param {{ lat: number, lng: number }} destination
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function startTrip(tripId, driverId, origin, destination, options = {}) {
    const redis = getRedisClient();
    const idInfo = await resolveOrderIds(tripId);
    const primaryTripId = idInfo.rawId || String(tripId).trim();
    const allTripIds = idInfo.allIds.length > 0 ? idInfo.allIds : [primaryTripId];

    // ── Step 1: Distributed Lock (SETNX) ───────────────────────────────────────
    const lockKey = `trip:start:${primaryTripId}`;
    const lockTtl = parseInt(process.env.TRIP_START_LOCK_TTL_SEC || '10', 10);
    let lockAcquired = null;

    if (redis) {
        lockAcquired = await redis.set(lockKey, '1', 'EX', lockTtl, 'NX');
    } else {
        lockAcquired = 'OK'; // Fallback if running without Redis
    }

    if (lockAcquired !== 'OK') {
        for (let attempt = 0; attempt < 5; attempt++) {
            await sleep(300);
            let cached = null;
            for (const tid of allTripIds) {
                cached = await redisGet(`active_route:${tid}`);
                if (cached) break;
            }
            if (cached) {
                metrics.increment('duplicate_requests_prevented');
                const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
                return { ...data, tripId: primaryTripId, driverId, fromCache: true };
            }
        }
        throw new Error('Trip start in progress — retry in 1s');
    }

    try {
        // ── Step 2: Active Route Cache & Drift Check ────────────────────────────
        let activeRaw = null;
        for (const tid of allTripIds) {
            activeRaw = await redisGet(`active_route:${tid}`);
            if (activeRaw) break;
        }

        if (activeRaw && !options.forceRefresh && !options.forceReroute) {
            const active = typeof activeRaw === 'string' ? JSON.parse(activeRaw) : activeRaw;

            const activeDest = active.destination || {};
            const hasValidActiveDest = activeDest.lat != null && activeDest.lng != null;
            const hasValidLastOrigin = active.lastOriginLat != null && active.lastOriginLng != null;

            if (hasValidActiveDest && hasValidLastOrigin) {
                const originDrift = haversineDistance(
                    { lat: origin.lat, lng: origin.lng },
                    { lat: active.lastOriginLat, lng: active.lastOriginLng }
                );

                const destDrift = haversineDistance(
                    { lat: destination.lat, lng: destination.lng },
                    { lat: activeDest.lat, lng: activeDest.lng }
                );

                const ORIGIN_CACHE_MAX_M = parseInt(process.env.ORIGIN_DRIFT_CACHE_MAX_M || '25', 10);

                if (originDrift < ORIGIN_CACHE_MAX_M && destDrift < 15) {
                    logger.info(`[Trip] Active Route Cache HIT for tripId=${primaryTripId} (originDrift=${originDrift.toFixed(1)}m, destDrift=${destDrift.toFixed(1)}m)`);
                    metrics.increment('active_route_cache_hit');
                    return {
                        tripId: primaryTripId,
                        driverId,
                        encodedPolyline: active.encodedPolyline,
                        distanceMeters:  active.distanceMeters,
                        durationSeconds: active.durationSeconds,
                        routeToken:      active.routeToken,
                        legs:            active.legs,
                        routeVersion:    active.routeVersion,
                        origin:          active.origin || { lat: active.lastOriginLat, lng: active.lastOriginLng },
                        destination:     active.destination || destination,
                        fromCache:       true,
                    };
                }

                logger.info(`[Trip] Route drifted (originDrift=${originDrift.toFixed(1)}m, destDrift=${destDrift.toFixed(1)}m) for tripId=${primaryTripId} — recalculating route`);
                metrics.increment('origin_drift_reroute');
            }
        }

        // ── Step 3: Memory → Redis → Google (3 Layers) ──────────────────────────
        const params   = buildRouteParams(origin, destination, options);
        const cacheKey = buildRouteCacheKey(params);
        const routeData = await getRouteFromAllLayers(cacheKey, () => callGoogleRoutesAPI(params));

        // ── Step 4: Save Active Route Cache ─────────────────────────────────────
        let existingTrip = null;
        for (const tid of allTripIds) {
            existingTrip = await Trip.findById(tid).select('routeVersion startedAt').lean();
            if (existingTrip) break;
        }
        const newVersion   = (existingTrip?.routeVersion || 0) + 1;
        const activeTtl    = parseInt(process.env.ACTIVE_ROUTE_CACHE_TTL_SEC || '7200', 10);

        const activePayload = {
            encodedPolyline: routeData.encodedPolyline,
            distanceMeters:  routeData.distanceMeters,
            durationSeconds: routeData.durationSeconds,
            routeToken:      routeData.routeToken || null,
            legs:            routeData.legs       || [],
            routeVersion:    newVersion,
            destination,
            lastOriginLat:   origin.lat,
            lastOriginLng:   origin.lng,
            savedAt:         Date.now(),
        };

        for (const tid of allTripIds) {
            await redisSet(`active_route:${tid}`, activePayload, activeTtl);
        }

        // ── Step 5: Save MongoDB & Redis Trip document ───────────────────────────
        for (const tid of allTripIds) {
            await Trip.findByIdAndUpdate(tid, {
                _id:              tid,
                driverId,
                status:           'active',
                encodedPolyline:  routeData.encodedPolyline,
                distanceMeters:   routeData.distanceMeters,
                durationSeconds:  routeData.durationSeconds,
                routeToken:       routeData.routeToken || null,
                legs:             routeData.legs       || [],
                origin,
                destination,
                startedAt:        existingTrip?.startedAt || new Date(),
                routeVersion:     newVersion,
            }, { upsert: true, new: true });
        }

        const tripData = {
            tripId: primaryTripId,
            driverId,
            encodedPolyline:  routeData.encodedPolyline,
            decodedPolyline:  routeData.polylinePoints || decodePolyline(routeData.encodedPolyline),
            distanceMeters:   routeData.distanceMeters,
            durationSeconds:  routeData.durationSeconds,
            routeToken:       routeData.routeToken,
            legs:             routeData.legs,
            routeVersion:     newVersion,
            origin,
            destination,
            status:           'active',
            startedAt:        new Date().toISOString(),
            fromCache:        routeData.fromCache,
            cacheLayer:       routeData.cacheLayer,
        };

        for (const tid of allTripIds) {
            await redisSet(`trip:${tid}`, tripData, activeTtl);
        }

        // 🚀 Broadcast route update via Socket.IO to customer & driver rooms
        const io = options.io || (options.req && options.req.app ? options.req.app.get('io') : null);
        if (io) {
            try {
                broadcastRoute(tripData, options.reason || 'start_trip', io);
                const socketPayload = {
                    tripId: primaryTripId,
                    numericOrderId: idInfo.numericId ? Number(idInfo.numericId) : null,
                    mongoOrderId: idInfo.mongoId || null,
                    encodedPolyline:  routeData.encodedPolyline,
                    distanceMeters:   routeData.distanceMeters,
                    durationSeconds:  routeData.durationSeconds,
                    reason:           options.reason || 'start_trip',
                    routeVersion:     newVersion,
                    version:          newVersion,
                    origin,
                    destination,
                    routeChanged:     true,
                    trafficChanged:   false,
                    etaChanged:       true,
                    distanceChanged:  true,
                    fromCache:        routeData.fromCache,
                };

                for (const tid of allTripIds) {
                    io.to(`trip:${tid}`).emit('routeUpdated', socketPayload);
                    io.to(`order:${tid}`).emit('routeUpdated', socketPayload);
                    if (io.of) {
                        io.of('/ride').to(`trip:${tid}`).emit('routeUpdated', socketPayload);
                        io.of('/tracking').to(`trip:${tid}`).emit('routeUpdated', socketPayload);
                        io.of('/tracking').to(`order:${tid}`).emit('routeUpdated', socketPayload);
                    }
                }
            } catch (broadcastErr) {
                logger.error(`[Trip] Broadcast error in startTrip: ${broadcastErr.message}`);
            }
        }

        return tripData;

    } finally {
        await redisDel(lockKey);
    }
}

// ── 2. Driver Location & Rerouting Pipeline v3 ───────────────────────────────

/**
 * Handle location update and trigger rerouting if off route.
 * @param {string} tripId
 * @param {string} driverId
 * @param {object} location
 * @param {number} [heading]
 * @param {object} [io]
 * @param {object} [options]
 */
async function processLocationUpdate(tripId, driverId, location, heading, io, options = {}) {
    const idInfo = await resolveOrderIds(tripId);
    const primaryTripId = idInfo.rawId || String(tripId).trim();
    const allTripIds = idInfo.allIds.length > 0 ? idInfo.allIds : [primaryTripId];

    const driverLat = location.lat;
    const driverLng = location.lng;
    const speed = location.speed != null ? Number(location.speed) : null;
    const forceReroute = options.forceReroute === true;

    let trip = null;
    for (const tid of allTripIds) {
        trip = await redisGet(`trip:${tid}`);
        if (trip) break;
    }

    if (!trip) {
        for (const tid of allTripIds) {
            const mongoTrip = await Trip.findById(tid).lean();
            if (mongoTrip) {
                trip = {
                    ...mongoTrip,
                    tripId: mongoTrip._id,
                    decodedPolyline: mongoTrip.encodedPolyline ? decodePolyline(mongoTrip.encodedPolyline) : [],
                };
                break;
            }
        }
    }

    if (!trip || !trip.encodedPolyline) {
        return { isOffRoute: false, rerouted: false };
    }

    const routePoints = trip.decodedPolyline && trip.decodedPolyline.length > 0
        ? trip.decodedPolyline
        : decodePolyline(trip.encodedPolyline);

    const { isOffRoute, isImmediate, distanceFromRoute } = checkOffRoute(primaryTripId, { lat: driverLat, lng: driverLng, heading, speed }, routePoints);

    const OFF_ROUTE_M = parseInt(process.env.OFF_ROUTE_THRESHOLD_M || '35', 10);

    if (!forceReroute && !isOffRoute && distanceFromRoute < OFF_ROUTE_M) {
        return { isOffRoute: false, rerouted: false, distanceFromRoute };
    }

    const cooldownActive = await isCooldownActive(primaryTripId);

    if (!forceReroute && cooldownActive && !isImmediate) {
        metrics.increment('reroute_cooldown_blocked');
        logger.info(`[Reroute] ${primaryTripId} blocked by cooldown — ${distanceFromRoute.toFixed(0)}m off route (wrongDirection=${isOffRoute})`);
        return { isOffRoute: true, rerouted: false, distanceFromRoute, cooldownBlocked: true };
    }

    // Set cooldown before calling API
    await markRerouted(primaryTripId);

    try {
        const dest = (options && options.destination && options.destination.lat != null && options.destination.lng != null)
            ? options.destination
            : (trip.destination || { lat: driverLat, lng: driverLng });
        const params = buildRouteParams({ lat: driverLat, lng: driverLng }, dest, { heading, speed });
        const cacheKey = buildRouteCacheKey(params);

        let newRoute;
        try {
            newRoute = await callGoogleRoutesAPI(params);
            newRoute.fromCache = false;
            newRoute.cacheLayer = 'google';
            const ttl = parseInt(process.env.ROUTE_CACHE_GEOMETRY_TTL_SEC || '3600', 10);
            redisSet(cacheKey, newRoute, ttl).catch(() => {});
            memoryRouteCache.set(cacheKey, newRoute);
        } catch (apiErr) {
            logger.warn(`[Reroute] Direct Google call failed (${apiErr.message}) — falling back to cache layers`);
            newRoute = await getRouteFromAllLayers(cacheKey, () => callGoogleRoutesAPI(params));
        }

        let existingRerouteTrip = null;
        for (const tid of allTripIds) {
            existingRerouteTrip = await Trip.findById(tid).select('routeVersion').lean();
            if (existingRerouteTrip) break;
        }

        const baseVersion = Math.max(
            trip.routeVersion || 0,
            existingRerouteTrip?.routeVersion || 0
        );
        const newVersion = baseVersion + 1;
        newRoute.routeVersion = newVersion;
        newRoute.tripId = primaryTripId;
        newRoute.reason = forceReroute ? 'off_route_forced' : (isImmediate ? 'off_route_immediate' : 'off_route');

        // Update Active Route Cache across all IDs
        const activeTtl = parseInt(process.env.ACTIVE_ROUTE_CACHE_TTL_SEC || '7200', 10);
        const activePayload = {
            encodedPolyline: newRoute.encodedPolyline,
            distanceMeters:  newRoute.distanceMeters,
            durationSeconds: newRoute.durationSeconds,
            routeToken:      newRoute.routeToken,
            legs:            newRoute.legs,
            routeVersion:    newVersion,
            destination:     dest,
            lastOriginLat:   driverLat,
            lastOriginLng:   driverLng,
            savedAt:         Date.now(),
        };

        for (const tid of allTripIds) {
            await redisSet(`active_route:${tid}`, activePayload, activeTtl);
        }

        // Update MongoDB across all IDs
        for (const tid of allTripIds) {
            await Trip.findByIdAndUpdate(tid, {
                encodedPolyline: newRoute.encodedPolyline,
                distanceMeters:  newRoute.distanceMeters,
                durationSeconds: newRoute.durationSeconds,
                routeToken:      newRoute.routeToken,
                legs:            newRoute.legs,
                lastRerouteAt:   new Date(),
                routeVersion:    newVersion,
                destination:     dest,
            });
        }

        // Update Redis Trip cache across all IDs
        trip.encodedPolyline = newRoute.encodedPolyline;
        trip.decodedPolyline = newRoute.polylinePoints || decodePolyline(newRoute.encodedPolyline);
        trip.distanceMeters  = newRoute.distanceMeters;
        trip.durationSeconds = newRoute.durationSeconds;
        trip.routeVersion    = newVersion;
        trip.destination     = dest;

        for (const tid of allTripIds) {
            await redisSet(`trip:${tid}`, trip, activeTtl);
        }

        metrics.increment('reroute_count');
        if (isImmediate) metrics.increment('reroute_immediate');

        if (io) {
            const socketPayload = {
                tripId: primaryTripId,
                numericOrderId: idInfo.numericId ? Number(idInfo.numericId) : null,
                mongoOrderId: idInfo.mongoId || null,
                encodedPolyline:  newRoute.encodedPolyline,
                distanceMeters:   newRoute.distanceMeters,
                durationSeconds:  newRoute.durationSeconds,
                reason:           forceReroute ? 'off_route_forced' : (isImmediate ? 'off_route_immediate' : 'off_route'),
                routeVersion:     newVersion,
                version:          newVersion,
                routeChanged:     true,
                trafficChanged:   false,
                etaChanged:       true,
                distanceChanged:  true,
                fromCache:        newRoute.fromCache,
            };

            try {
                broadcastRoute({ ...trip, tripId: primaryTripId }, socketPayload.reason, io);
                for (const tid of allTripIds) {
                    io.to(`trip:${tid}`).emit('routeUpdated', socketPayload);
                    io.to(`order:${tid}`).emit('routeUpdated', socketPayload);
                    if (io.of) {
                        io.of('/ride').to(`trip:${tid}`).emit('routeUpdated', socketPayload);
                        io.of('/tracking').to(`trip:${tid}`).emit('routeUpdated', socketPayload);
                        io.of('/tracking').to(`order:${tid}`).emit('routeUpdated', socketPayload);
                    }
                }
            } catch (broadcastErr) {
                logger.error(`[Trip] Reroute broadcast error: ${broadcastErr.message}`);
            }
        }

        return {
            trip,
            isOffRoute: true,
            rerouted: true,
            distanceFromRoute,
            newRoute,
            currentRoute: newRoute,
        };

    } catch (err) {
        logger.error(`[Reroute] Failed for ${primaryTripId}: ${err.message}`);
        return { isOffRoute: true, rerouted: false, error: err.message };
    }
}

// ── 3. Trip End Pipeline v3 ───────────────────────────────────────────────────

/**
 * End trip and clean active route cache.
 * @param {string} tripId
 * @param {string} [driverId]
 * @param {object} [io]
 */
async function endTrip(tripId, driverId, io) {
    const idInfo = await resolveOrderIds(tripId);
    const primaryTripId = idInfo.rawId || String(tripId).trim();
    const allTripIds = idInfo.allIds.length > 0 ? idInfo.allIds : [primaryTripId];

    const completedAt = new Date().toISOString();
    for (const tid of allTripIds) {
        await Trip.findByIdAndUpdate(tid, { status: 'completed', completedAt: new Date() });
        await redisDel(`active_route:${tid}`);
        await redisDel(`trip:${tid}`);
        await clearTripState(tid);
        if (io) {
            io.to(`trip:${tid}`).emit('tripCompleted', { tripId: tid, completedAt });
            io.to(`order:${tid}`).emit('tripCompleted', { tripId: tid, completedAt });
            if (io.of) {
                io.of('/ride').to(`trip:${tid}`).emit('tripCompleted', { tripId: tid, completedAt });
                io.of('/tracking').to(`trip:${tid}`).emit('tripCompleted', { tripId: tid, completedAt });
            }
        }
    }

    return { tripId: primaryTripId, status: 'completed', completedAt };
}

async function getTrip(tripId) {
    const idInfo = await resolveOrderIds(tripId);
    const allTripIds = idInfo.allIds.length > 0 ? idInfo.allIds : [String(tripId).trim()];

    for (const tid of allTripIds) {
        const cached = await redisGet(`trip:${tid}`);
        if (cached) return cached;
    }
    for (const tid of allTripIds) {
        const mongoTrip = await Trip.findById(tid).lean();
        if (mongoTrip) {
            return {
                ...mongoTrip,
                tripId: mongoTrip._id,
                decodedPolyline: mongoTrip.encodedPolyline ? decodePolyline(mongoTrip.encodedPolyline) : [],
            };
        }
    }
    return null;
}

async function getDriverLocation(driverId) {
    return await redisGet(`driver:loc:${driverId}`);
}

module.exports = {
    startTrip,
    processLocationUpdate,
    endTrip,
    getTrip,
    getDriverLocation,
};
