/**
 * polyline.js
 * Utility functions for:
 *  - Decoding Google encoded polyline strings into lat/lng arrays
 *  - Encoding lat/lng arrays back to Google encoded polyline
 *  - Haversine distance calculation between two geo-coordinates
 *  - Perpendicular distance from a point to a polyline (off-route detection)
 */

const EARTH_RADIUS_M = 6371000; // metres

/**
 * Convert degrees to radians.
 * @param {number} deg
 * @returns {number}
 */
function toRad(deg) {
    return (deg * Math.PI) / 180;
}

/**
 * Haversine distance between two lat/lng points in metres.
 * @param {{ lat: number, lng: number }} a
 * @param {{ lat: number, lng: number }} b
 * @returns {number} distance in metres
 */
function haversineDistance(a, b) {
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
 * Compute bearing from point A to point B in degrees (0-360).
 * @param {{ lat: number, lng: number }} a
 * @param {{ lat: number, lng: number }} b
 * @returns {number}
 */
function computeBearing(a, b) {
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLng = toRad(b.lng - a.lng);

    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) -
              Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

    const brng = Math.atan2(y, x);
    return (brng * 180 / Math.PI + 360) % 360;
}

/**
 * Decode a Google Maps encoded polyline string into an array of {lat, lng} objects.
 * @param {string} encoded - Google encoded polyline
 * @returns {{ lat: number, lng: number }[]}
 */
function decodePolyline(encoded) {
    if (!encoded || typeof encoded !== 'string') return [];

    const points = [];
    let index = 0;
    let lat = 0;
    let lng = 0;

    while (index < encoded.length) {
        let result = 0;
        let shift = 0;
        let byte;

        // Decode latitude
        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        lat += result & 1 ? ~(result >> 1) : result >> 1;

        result = 0;
        shift = 0;

        // Decode longitude
        do {
            byte = encoded.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);

        lng += result & 1 ? ~(result >> 1) : result >> 1;

        points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }

    return points;
}

/**
 * Encode an array of {lat, lng} objects into a Google Maps encoded polyline string.
 * @param {{ lat: number, lng: number }[]} points
 * @returns {string}
 */
function encodePolyline(points) {
    if (!Array.isArray(points) || points.length === 0) return '';

    let output = '';
    let prevLat = 0;
    let prevLng = 0;

    const encodeValue = (val) => {
        let value = Math.round(val * 1e5);
        value = value < 0 ? ~(value << 1) : value << 1;
        let chunk = '';
        while (value >= 0x20) {
            chunk += String.fromCharCode(((0x20 | (value & 0x1f)) + 63));
            value >>= 5;
        }
        chunk += String.fromCharCode(value + 63);
        return chunk;
    };

    for (const point of points) {
        output += encodeValue(point.lat - prevLat);
        output += encodeValue(point.lng - prevLng);
        prevLat = point.lat;
        prevLng = point.lng;
    }

    return output;
}

/**
 * Find the minimum distance (in metres) from a point to the closest segment of a polyline.
 * Uses point-to-segment perpendicular distance math.
 *
 * @param {{ lat: number, lng: number }} point
 * @param {{ lat: number, lng: number }[]} polylinePoints
 * @returns {{ distance: number, closestSegment: { a: object, b: object }|null }}
 */
function distanceFromPolyline(point, polylinePoints) {
    if (!polylinePoints || polylinePoints.length === 0) return { distance: Infinity, closestSegment: null, closestIndex: -1 };
    if (polylinePoints.length === 1) return { distance: haversineDistance(point, polylinePoints[0]), closestSegment: { a: polylinePoints[0], b: polylinePoints[0] }, closestIndex: 0 };

    let minDist = Infinity;
    let closestSeg = null;
    let closestIndex = -1;

    for (let i = 0; i < polylinePoints.length - 1; i++) {
        const segStart = polylinePoints[i];
        const segEnd = polylinePoints[i + 1];
        const dist = pointToSegmentDistance(point, segStart, segEnd);
        if (dist < minDist) {
            minDist = dist;
            closestSeg = { a: segStart, b: segEnd };
            closestIndex = i;
        }
    }

    return { distance: minDist, closestSegment: closestSeg, closestIndex };
}

/**
 * Shortest distance from a point P to the line segment AB, in metres.
 * Projects P onto AB; if projection falls outside the segment, uses the nearer endpoint.
 *
 * @param {{ lat: number, lng: number }} p
 * @param {{ lat: number, lng: number }} a
 * @param {{ lat: number, lng: number }} b
 * @returns {number}
 */
function pointToSegmentDistance(p, a, b) {
    const ax = a.lng, ay = a.lat;
    const bx = b.lng, by = b.lat;
    const px = p.lng, py = p.lat;

    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    if (lenSq === 0) return haversineDistance(p, a);

    // Parameter t for projection onto segment [0,1]
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));

    const nearest = { lat: ay + t * dy, lng: ax + t * dx };
    return haversineDistance(p, nearest);
}

module.exports = {
    haversineDistance,
    decodePolyline,
    encodePolyline,
    distanceFromPolyline,
    computeBearing,
};
