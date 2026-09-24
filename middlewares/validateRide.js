/**
 * validateRide.js
 * Request validation middleware for ride-tracking endpoints.
 * Uses manual validation (no external schema library dependency beyond what's installed).
 */

const logger = require('../utils/logger');

/**
 * Validate a lat/lng object.
 * @param {{ lat: any, lng: any }} obj
 * @returns {string|null} error message, or null if valid
 */
function validateLatLng(obj, prefix = '') {
    if (!obj || typeof obj !== 'object') return `${prefix} must be an object with lat and lng`;
    const lat = Number(obj.lat);
    const lng = Number(obj.lng);
    if (isNaN(lat) || lat < -90 || lat > 90) return `${prefix}.lat must be a valid latitude (-90 to 90)`;
    if (isNaN(lng) || lng < -180 || lng > 180) return `${prefix}.lng must be a valid longitude (-180 to 180)`;
    return null;
}

/**
 * Middleware: Validate POST /api/trip/start body.
 * Required: tripId (string), origin { lat, lng }, destination { lat, lng }
 */
function validateStartTrip(req, res, next) {
    const { tripId, origin, destination } = req.body;

    const errors = [];

    if (!tripId || typeof tripId !== 'string' || tripId.trim() === '') {
        errors.push('tripId must be a non-empty string');
    }

    const originErr = validateLatLng(origin, 'origin');
    if (originErr) errors.push(originErr);

    const destErr = validateLatLng(destination, 'destination');
    if (destErr) errors.push(destErr);

    if (errors.length > 0) {
        logger.warn('[Validate] startTrip validation failed:', errors);
        return res.status(400).json({ success: false, message: errors.join('; ') });
    }

    // Normalize numbers
    req.body.origin = { lat: Number(origin.lat), lng: Number(origin.lng) };
    req.body.destination = { lat: Number(destination.lat), lng: Number(destination.lng) };
    req.body.tripId = tripId.trim();

    next();
}

/**
 * Middleware: Validate POST /api/driver/location body.
 * Required: tripId (string), lat (number), lng (number)
 */
function validateLocation(req, res, next) {
    const { tripId, lat, lng } = req.body;
    const errors = [];

    if (!tripId || typeof tripId !== 'string' || tripId.trim() === '') {
        errors.push('tripId must be a non-empty string');
    }

    const latNum = Number(lat);
    const lngNum = Number(lng);

    if (lat == null || isNaN(latNum) || latNum < -90 || latNum > 90) {
        errors.push('lat must be a valid latitude (-90 to 90)');
    }
    if (lng == null || isNaN(lngNum) || lngNum < -180 || lngNum > 180) {
        errors.push('lng must be a valid longitude (-180 to 180)');
    }

    if (errors.length > 0) {
        logger.warn('[Validate] updateLocation validation failed:', errors);
        return res.status(400).json({ success: false, message: errors.join('; ') });
    }

    req.body.tripId = tripId.trim();
    req.body.lat = latNum;
    req.body.lng = lngNum;
    
    // Process optional heading
    const { heading } = req.body;
    if (heading !== undefined && heading !== null) {
        const h = Number(heading);
        if (!isNaN(h) && h >= 0 && h <= 360) {
            req.body.heading = h;
        } else {
            req.body.heading = null;
        }
    } else {
        req.body.heading = null;
    }

    next();
}

module.exports = { validateStartTrip, validateLocation };
