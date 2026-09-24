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
function broadcastRoute(trip, reason, io) {
    if (!trip || !trip.tripId) return;

    const broadcastStartTime = Date.now();

    // Standardized Payload required by Flutter
    const payload = {
        version: trip.routeVersion || 1,
        checksum: trip.routeChecksum || '',
        generatedAt: Date.now(),
        source: trip.routeSource || 'UNKNOWN',
        reason: reason,
        
        // V1 legacy fields
        tripId: trip.tripId,
        routeChanged: ['PendingRecovered', 'off_route', 'initial'].includes(reason),
        trafficChanged: true,
        etaChanged: true,
        distanceChanged: true,
        
        // Data
        encodedPolyline: trip.encodedPolyline || '',
        distanceMeters: trip.distanceMeters || 0,
        durationSeconds: trip.durationSeconds || 0,
        trafficSegments: trip.trafficSegments || [],
        trafficDataVersion: trip.trafficDataVersion || 1,
    };

    // Broadcast to V1 old driver app
    io.of('/ride').to(`trip:${trip.tripId}`).emit('routeUpdated', payload);
    
    // Broadcast to V5 new tracking flutter app
    io.of('/tracking').to(`trip:${trip.tripId}`).emit('trip.route.updated', payload);
    
    // Broadcast to customer fallback order room
    io.to(`order:${trip.tripId}`).emit('trip.route.updated', payload);

    metrics.timing('broadcast_time', Date.now() - broadcastStartTime);
    metrics.increment('socketRouteUpdates');
    
    console.log(`[BROADCAST_ROUTE] tripId=${trip.tripId} reason=${reason} version=${payload.version}`);
}

module.exports = {
    broadcastRoute,
};
