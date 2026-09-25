/**
 * googleRoutesService.js
 * Service layer for interacting with Google Routes API (v2) with strict FieldMask.
 *
 * Google Routes API endpoint: POST https://routes.googleapis.com/directions/v2:computeRoutes
 * FieldMask strictly limits requested fields to minimize bandwidth and billing tier.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const metrics = require('../utils/metrics');
const { decodePolyline } = require('../utils/polyline');

const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * Perform direct Google Routes API POST call with optimized FieldMask.
 * @param {object} params
 * @param {number} params.originLat
 * @param {number} params.originLng
 * @param {number} params.destLat
 * @param {number} params.destLng
 * @param {string} [params.travelMode='DRIVE']
 * @param {string} [params.routingPreference='TRAFFIC_AWARE']
 * @param {boolean} [params.avoidTolls=false]
 * @param {boolean} [params.avoidHighways=false]
 * @param {string} [params.language='ar']
 * @returns {Promise<{
 *   encodedPolyline: string,
 *   distanceMeters: number,
 *   durationSeconds: number,
 *   routeToken: string|null,
 *   legs: Array,
 *   polylinePoints: Array
 * }>}
 */
async function callGoogleRoutesAPI(params) {
    const apiKey = process.env.GOOGLE_ROUTES_API_KEY || process.env.GOOGLE_MAPS_KEY;
    if (!apiKey) {
        logger.error('[GoogleRoutes] GOOGLE_ROUTES_API_KEY missing from environment');
        throw new Error('GOOGLE_ROUTES_API_KEY is not configured');
    }

    const hasIntermediates = params.intermediates && Array.isArray(params.intermediates) && params.intermediates.length > 0;
    const shouldOptimizeOrder = hasIntermediates && params.optimizeWaypointOrder !== false;

    // Only apply heading if driver is actually moving (speed >= 2.0 m/s) and the
    // heading value is finite and within [0, 360). Compass/fused bearings from the
    // Flutter side can arrive as NaN or outside range when the sensor isn't settled.
    // A bad heading sent to Google Routes causes it to assume the driver is facing
    // the wrong direction, resulting in a U-turn or loop in the returned polyline.
    // We only pass heading if the driver is actively moving (speed >= 2.0 m/s).
    const isSpeedValid = params.speed != null && Number(params.speed) >= 2.0;
    const isHeadingFinite = params.heading != null &&
        isFinite(Number(params.heading)) &&
        Number(params.heading) >= 0 &&
        Number(params.heading) < 360;
    const hasValidHeading = isHeadingFinite && isSpeedValid;

    const body = {
        origin: {
            location: {
                latLng: { latitude: params.originLat, longitude: params.originLng },
                ...(hasValidHeading ? { heading: Math.round(params.heading) } : {})
            },
        },
        destination: {
            location: { latLng: { latitude: params.destLat, longitude: params.destLng } },
        },
        travelMode:               params.travelMode       || 'DRIVE',
        routingPreference:        params.routingPreference || 'TRAFFIC_AWARE',
        polylineQuality:          'HIGH_QUALITY',
        polylineEncoding:         'ENCODED_POLYLINE',
        computeAlternativeRoutes: false,
        languageCode:             params.language          || 'ar',
        units:                    'METRIC',
        routeModifiers: {
            avoidTolls:    params.avoidTolls    || false,
            avoidHighways: params.avoidHighways || false,
            avoidFerries:  false,
        },
        ...(shouldOptimizeOrder ? { optimizeWaypointOrder: true } : {}),
    };

    if (hasIntermediates) {
        body.intermediates = params.intermediates.map(wp => ({
            location: {
                latLng: {
                    latitude: wp.lat !== undefined ? Number(wp.lat) : Number(wp.latitude || 0),
                    longitude: wp.lng !== undefined ? Number(wp.lng) : Number(wp.longitude || 0),
                }
            }
        }));
    }

    const fieldMaskArray = [
        'routes.duration',
        'routes.distanceMeters',
        'routes.polyline.encodedPolyline',
        'routes.routeToken',
        'routes.legs.distanceMeters',
        'routes.legs.duration',
        'routes.legs.polyline.encodedPolyline',
    ];

    if (shouldOptimizeOrder) {
        fieldMaskArray.push('routes.optimizedIntermediateWaypointIndex');
    }

    const fieldMask = fieldMaskArray.join(',');

    logger.info(`[GoogleRoutes] Invoking Google Routes API v2 (intermediates: ${params.intermediates?.length || 0}, optimizeOrder: ${shouldOptimizeOrder})`);

    const response = await fetch(ROUTES_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type':     'application/json',
            'X-Goog-Api-Key':   apiKey,
            'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errText = await response.text();
        logger.error(`[GoogleRoutes] API error ${response.status}: ${errText}`);
        throw new Error(`Google Routes API ${response.status}: ${errText}`);
    }

    const data  = await response.json();
    const route = data.routes?.[0];
    if (!route) throw new Error('No route returned from Google Routes API');

    const encodedPolyline = route.polyline?.encodedPolyline || '';
    const polylinePoints  = encodedPolyline ? decodePolyline(encodedPolyline) : [];
    const legPolylines    = (route.legs || []).map(leg => leg.polyline?.encodedPolyline).filter(Boolean);

    return {
        encodedPolyline,
        distanceMeters:  route.distanceMeters || 0,
        durationSeconds: parseInt((route.duration || '0s').replace('s', ''), 10) || 0,
        routeToken:      route.routeToken || null,
        legs:            route.legs || [],
        legPolylines,
        polylinePoints,
        optimizedIntermediateWaypointIndex: route.optimizedIntermediateWaypointIndex || null,
    };
}

/**
 * Backward compatibility wrapper for calculateRoute
 */
async function calculateRoute(origin, destination, options = {}) {
    const params = {
        originLat: origin.lat ?? origin.latitude,
        originLng: origin.lng ?? origin.longitude,
        destLat: destination.lat ?? destination.latitude,
        destLng: destination.lng ?? destination.longitude,
        heading: options.heading !== undefined ? options.heading : (origin.heading !== undefined ? origin.heading : null),
        speed: options.speed !== undefined ? options.speed : (origin.speed !== undefined ? origin.speed : null),
        intermediates: options.intermediates || [],
        optimizeWaypointOrder: options.optimizeWaypointOrder !== false,
        travelMode: options.travelMode || 'DRIVE',
        routingPreference: options.routingPreference || 'TRAFFIC_AWARE',
        avoidTolls: options.avoidTolls || false,
        avoidHighways: options.avoidHighways || false,
        language: options.language || 'ar',
    };
    return await callGoogleRoutesAPI(params);
}

module.exports = {
    callGoogleRoutesAPI,
    calculateRoute,
};
