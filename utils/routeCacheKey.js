/**
 * routeCacheKey.js
 * Geohash-based route cache key builder.
 * Incorporates origin & destination geohashes and all route modifiers.
 */

let ngeohash = null;
try {
    ngeohash = require('ngeohash');
} catch (e) {
    // Fallback if package is not yet installed
}

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function fallbackGeohash(lat, lng, precision = 7) {
    let isEven = true;
    let latMin = -90, latMax = 90;
    let lngMin = -180, lngMax = 180;
    let bit = 0;
    let ch = 0;
    let geohashStr = '';

    while (geohashStr.length < precision) {
        if (isEven) {
            const mid = (lngMin + lngMax) / 2;
            if (lng > mid) {
                ch |= (1 << (4 - bit));
                lngMin = mid;
            } else {
                lngMax = mid;
            }
        } else {
            const mid = (latMin + latMax) / 2;
            if (lat > mid) {
                ch |= (1 << (4 - bit));
                latMin = mid;
            } else {
                latMax = mid;
            }
        }
        isEven = !isEven;
        if (bit < 4) {
            bit++;
        } else {
            geohashStr += BASE32[ch];
            bit = 0;
            ch = 0;
        }
    }
    return geohashStr;
}

function encodeGeohash(lat, lng, precision = 7) {
    if (ngeohash && typeof ngeohash.encode === 'function') {
        return ngeohash.encode(lat, lng, precision);
    }
    return fallbackGeohash(lat, lng, precision);
}

function buildRouteCacheKey(params) {
    // Origin uses high precision (9 ≈ 2.4m) so every distinct driver position
    // gets its own cache entry — prevents stale routes from nearby cells being
    // returned when driver has moved even a few metres.
    // Destination uses lower precision (7 ≈ 150m) since small dest variations
    // map to the same road point and don't need per-metre accuracy.
    const destPrecision   = parseInt(process.env.ROUTE_CACHE_GEOHASH_PRECISION || '7', 10);
    const originPrecision = parseInt(process.env.ROUTE_CACHE_ORIGIN_GEOHASH_PRECISION || '9', 10);

    const {
        originLat, originLng,
        destLat,   destLng,
        travelMode        = 'DRIVE',
        routingPreference = 'TRAFFIC_AWARE',
        vehicleType       = 'CAR',
        avoidTolls        = false,
        avoidHighways     = false,
        language          = 'ar',
    } = params;

    const oHash = encodeGeohash(originLat, originLng, originPrecision);
    const dHash = encodeGeohash(destLat,   destLng,   destPrecision);

    return [
        'route_geo',
        oHash,
        dHash,
        (travelMode || 'drive').toLowerCase(),
        (routingPreference || 'traffic_aware').toLowerCase(),
        (vehicleType || 'car').toLowerCase(),
        avoidTolls    ? 'notolls'  : 'tolls',
        avoidHighways ? 'nohwy'    : 'hwy',
        language || 'ar',
    ].join(':');
}

module.exports = {
    buildRouteCacheKey,
    encodeGeohash,
};
