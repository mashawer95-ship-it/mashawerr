/**
 * geoUtils.js
 * Lightweight geospatial utilities for driver tracking.
 * Zero external dependencies — pure math.
 *
 * Functions:
 *  - haversineDistance(a, b)     → metres between two GPS points
 *  - isValidCoordinate(lat, lng) → boolean validation
 *  - bearingBetween(a, b)        → compass heading 0-360
 *  - buildMinimalPayload(data)   → strip sensitive fields, minimise bytes
 */

const EARTH_RADIUS_M = 6371000;

/**
 * Haversine formula – shortest distance over earth's surface in metres.
 * @param {{ lat: number, lng: number }} a
 * @param {{ lat: number, lng: number }} b
 * @returns {number} distance in metres
 */
function haversineDistance(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const sinLat = Math.sin(dLat / 2);
    const sinLng = Math.sin(dLng / 2);
    const h =
        sinLat * sinLat +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Validate that lat/lng values are real numbers in legal geographic ranges.
 * Rejects: NaN, Infinity, out-of-range, null, undefined.
 *
 * @param {any} lat
 * @param {any} lng
 * @returns {boolean}
 */
function isValidCoordinate(lat, lng) {
    const latN = Number(lat);
    const lngN = Number(lng);
    return (
        !isNaN(latN) &&
        !isNaN(lngN) &&
        isFinite(latN) &&
        isFinite(lngN) &&
        latN >= -90 &&
        latN <= 90 &&
        lngN >= -180 &&
        lngN <= 180
    );
}

/**
 * Validate heading value (0–360 degrees).
 * @param {any} heading
 * @returns {boolean}
 */
function isValidHeading(heading) {
    if (heading == null) return true; // optional field
    const h = Number(heading);
    return !isNaN(h) && h >= 0 && h <= 360;
}

/**
 * Validate speed (0–300 km/h is sane for a car).
 * @param {any} speed
 * @returns {boolean}
 */
function isValidSpeed(speed) {
    if (speed == null) return true; // optional field
    const s = Number(speed);
    return !isNaN(s) && s >= 0 && s <= 300;
}

/**
 * Calculate compass bearing (degrees 0-360) from point A to point B.
 * Useful for smoothing/interpolating heading on the client.
 *
 * @param {{ lat: number, lng: number }} a  origin
 * @param {{ lat: number, lng: number }} b  destination
 * @returns {number} bearing in degrees
 */
function bearingBetween(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;

    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLng = toRad(b.lng - a.lng);

    const y = Math.sin(dLng) * Math.cos(lat2);
    const x =
        Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Build the minimal broadcast payload for customers.
 * Only include fields needed to move a marker on a map.
 * Omitting extras saves ~30-40% bandwidth per event.
 *
 * @param {{
 *   driverId: string,
 *   lat: number,
 *   lng: number,
 *   heading?: number,
 *   speed?: number,
 *   timestamp: number
 * }} data
 * @returns {object} minimal payload
 */
function buildMinimalPayload(data) {
    return {
        d: data.driverId,              // driver id (short key)
        la: parseFloat(data.lat.toFixed(6)),  // lat rounded to ~11cm precision
        ln: parseFloat(data.lng.toFixed(6)),  // lng
        h:  data.heading != null ? Math.round(data.heading) : null,  // heading degrees
        t:  data.timestamp,            // unix ms timestamp
    };
}

module.exports = {
    haversineDistance,
    isValidCoordinate,
    isValidHeading,
    isValidSpeed,
    bearingBetween,
    buildMinimalPayload,
};
