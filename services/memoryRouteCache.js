/**
 * memoryRouteCache.js
 * In-process Node.js LRU Cache & 3-Layer Route Retriever (Memory → Redis → Google API).
 */

let LRUCacheClass = null;
try {
    const lruModule = require('lru-cache');
    LRUCacheClass = lruModule.LRUCache || lruModule;
} catch (e) {
    // Fallback if package is not yet installed
}

class SimpleLRUMap {
    constructor({ max = 500, ttl = 120000 }) {
        this.max = max;
        this.ttl = ttl;
        this.cache = new Map();
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return undefined;
        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return undefined;
        }
        // Refresh position
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.max) {
            // Evict oldest (first key)
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        this.cache.set(key, { value, expiry: Date.now() + this.ttl });
    }
}

const maxItems = parseInt(process.env.MEMORY_ROUTE_CACHE_MAX_ITEMS || '500', 10);
const ttlMs    = parseInt(process.env.MEMORY_ROUTE_CACHE_TTL_MS   || '120000', 10);

const memoryRouteCache = LRUCacheClass
    ? new LRUCacheClass({ max: maxItems, ttl: ttlMs, allowStale: false })
    : new SimpleLRUMap({ max: maxItems, ttl: ttlMs });

const { redisGet, redisSet } = require('../config/redis');
const metrics = require('../utils/metrics');
const { circuitBreaker } = require('../utils/circuitBreaker');
const logger = require('../utils/logger');

/**
 * Resolve route from 3 layers: Memory LRU → Redis → Google Routes API.
 * @param {string} cacheKey
 * @param {Function} fetchFn - Function to call Google Routes API on cache miss
 * @returns {Promise<object>} Route data with fromCache & cacheLayer metadata
 */
async function getRouteFromAllLayers(cacheKey, fetchFn) {
    // Layer 1: Memory LRU Cache (Node.js in-process, <1ms)
    const memHit = memoryRouteCache.get(cacheKey);
    if (memHit) {
        metrics.increment('memory_cache_hit');
        return { ...memHit, fromCache: true, cacheLayer: 'memory' };
    }

    // Layer 2: Redis Geometry Cache
    const redisHit = await redisGet(cacheKey);
    if (redisHit) {
        const data = typeof redisHit === 'string' ? JSON.parse(redisHit) : redisHit;
        memoryRouteCache.set(cacheKey, data); // Warm memory cache
        metrics.increment('redis_cache_hit');
        return { ...data, fromCache: true, cacheLayer: 'redis' };
    }

    // Layer 3: Google Routes API (Wrapped with Circuit Breaker)
    if (circuitBreaker.isOpen('google')) {
        logger.warn(`[CircuitBreaker] Google Routes API circuit is OPEN — rejecting call for ${cacheKey}`);
        throw new Error('Google Routes API is currently unavailable (Circuit Open)');
    }

    try {
        const result = await fetchFn();
        circuitBreaker.recordSuccess('google');

        const ttl = parseInt(process.env.ROUTE_CACHE_GEOMETRY_TTL_SEC || '3600', 10);
        await redisSet(cacheKey, result, ttl);
        memoryRouteCache.set(cacheKey, result);

        metrics.increment('google_api_calls');
        return { ...result, fromCache: false, cacheLayer: 'google' };
    } catch (err) {
        circuitBreaker.recordFailure('google');
        metrics.increment('google_errors');
        throw err;
    }
}

module.exports = {
    memoryRouteCache,
    getRouteFromAllLayers,
};
