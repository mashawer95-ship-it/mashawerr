/**
 * BroadcastService.js
 * Single Source of Truth for Socket.IO emits.
 * Handles normalizing payloads and ensuring data consistency.
 */
const metrics = require('../utils/metrics');

/**
 * Broadcasts a route update to all relevant namespaces.
 *
 * @param {Object} trip - The trip object containing route data
 * @param {string} reason - The reason for the update (e.g., 'PendingRecovered', 'OffRoute', 'TrafficRefresh')
 * @param {Object} io - The global Socket.IO instance
 */
function broadcastRoute(trip, reason, io, allTripIds = []) {
    if (!trip || !trip.tripId) return;

    const broadcastStartTime = Date.now();
    const primaryId = String(trip.tripId).trim();
    const ids = Array.isArray(allTripIds) && allTripIds.length > 0 
        ? Array.from(new Set(allTripIds.map(id => String(id).trim()).filter(Boolean)))
        : [primaryId];

    const currentVersion = trip.routeVersion || trip.version || 1;

    // Standardized Payload required by Flutter
    const payload = {
        routeVersion: currentVersion,
        version: currentVersion,
        checksum: trip.routeChecksum || '',
        generatedAt: Date.now(),
        source: trip.routeSource || 'UNKNOWN',
        reason: reason,
        
        // V1 legacy fields
        tripId: primaryId,
        routeChanged: ['PendingRecovered', 'off_route', 'off_route_forced', 'off_route_immediate', 'initial', 'start_trip', 'start_trip_cache_hit'].includes(reason),
        trafficChanged: true,
        etaChanged: true,
        distanceChanged: true,
        
        // Data
        encodedPolyline: trip.encodedPolyline || '',
        distanceMeters: trip.distanceMeters || 0,
        durationSeconds: trip.durationSeconds || 0,
        origin: trip.origin || null,
        destination: trip.destination || null,
        trafficSegments: trip.trafficSegments || [],
        trafficDataVersion: trip.trafficDataVersion || currentVersion,
        fromCache: trip.fromCache === true,
    };

    // Clean, non-redundant broadcast per ID
    for (const tid of ids) {
        if (io.of) {
            io.of('/ride').to(`trip:${tid}`).emit('routeUpdated', payload);
            io.of('/tracking').to(`trip:${tid}`).emit('trip.route.updated', payload);
            io.of('/tracking').to(`order:${tid}`).emit('trip.route.updated', payload);
        } else {
            io.to(`trip:${tid}`).emit('routeUpdated', payload);
            io.to(`order:${tid}`).emit('trip.route.updated', payload);
        }
    }

    metrics.timing('broadcast_time', Date.now() - broadcastStartTime);
    metrics.increment('socketRouteUpdates');
    
    console.log(`[BROADCAST_ROUTE] tripId=${primaryId} reason=${reason} version=${payload.version}`);
}

module.exports = {
    broadcastRoute,
};
