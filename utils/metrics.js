/**
 * metrics.js
 * Comprehensive metrics tracking (Redis + In-Memory) for Google Routes API cost reduction.
 */

const { getRedisClient } = require('../config/redis');

const localMetrics = {};
const timers = {};

function increment(k, value = 1) {
    // 1. Local counter
    localMetrics[k] = (localMetrics[k] || 0) + value;

    // 2. Redis counter
    const redis = getRedisClient();
    if (redis) {
        redis.incrby(`m:${k}`, value).catch(() => {});
    }
}

function timing(k, ms) {
    if (!timers[k]) {
        timers[k] = { sum: 0, count: 0 };
    }
    timers[k].sum += ms;
    timers[k].count += 1;

    const redis = getRedisClient();
    if (redis) {
        redis.lpush(`m:t:${k}`, ms).catch(() => {});
    }
}

async function getMetricFromRedis(k) {
    const redis = getRedisClient();
    if (redis) {
        const val = await redis.get(`m:${k}`);
        return parseInt(val || '0', 10);
    }
    return localMetrics[k] || 0;
}

async function getAggregateMetrics() {
    const [mem, redisHit, active, google, prefetch, reroute, dupes, prefetchFail, errs, cooldownBlocked, immediateReroute, driftReroute] = await Promise.all([
        getMetricFromRedis('memory_cache_hit'),
        getMetricFromRedis('redis_cache_hit'),
        getMetricFromRedis('active_route_cache_hit'),
        getMetricFromRedis('google_api_calls'),
        getMetricFromRedis('prefetch_google_calls'),
        getMetricFromRedis('reroute_count'),
        getMetricFromRedis('duplicate_requests_prevented'),
        getMetricFromRedis('prefetch_failures'),
        getMetricFromRedis('google_errors'),
        getMetricFromRedis('reroute_cooldown_blocked'),
        getMetricFromRedis('reroute_immediate'),
        getMetricFromRedis('origin_drift_reroute'),
    ]);

    const totalRequests = mem + redisHit + active + google;
    const safeTotal = totalRequests > 0 ? totalRequests : 1;
    const savedPercentage = totalRequests > 0 ? ((1 - (google / safeTotal)) * 100).toFixed(1) : '100.0';

    return {
        totalRequests,
        googleCallsActual: google,
        prefetchedBefore: prefetch,
        prefetchFailures: prefetchFail,
        googleErrors: errs,
        savedFromGoogle: `${totalRequests - google} (${savedPercentage}%)`,
        rerouteCount: reroute,
        rerouteCooldownBlocked: cooldownBlocked,
        rerouteImmediate: immediateReroute,
        duplicatesPrevented: dupes,
        originDriftReroutes: driftReroute,
        cacheBreakdown: {
            memory: `${mem} (${(mem / safeTotal * 100).toFixed(1)}%)`,
            redis: `${redisHit} (${(redisHit / safeTotal * 100).toFixed(1)}%)`,
            active: `${active} (${(active / safeTotal * 100).toFixed(1)}%)`,
            google: `${google} (${(google / safeTotal * 100).toFixed(1)}%)`,
        },
    };
}

module.exports = {
    increment,
    timing,
    getAggregateMetrics,
    getMetricFromRedis,
};
