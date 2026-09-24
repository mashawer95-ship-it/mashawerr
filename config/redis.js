/**
 * redis.js
 * Redis client singleton using ioredis.
 *
 * - Connects once and reuses the connection across the app.
 * - Falls back gracefully when Redis is not available (NODE_ENV=development without Redis).
 * - All ride-tracking data is stored here for fast in-memory access.
 *
 * Key schema:
 *   trip:{tripId}          → JSON string of TripData
 *   driver:loc:{driverId}  → JSON string of { lat, lng, timestamp }
 *   route:{tripId}         → encoded polyline string (cached Google Routes response)
 */

const Redis = require('ioredis');
const crypto = require('crypto');
const logger = require('../utils/logger');

let client = null;
let isConnected = false;

/**
 * Create and return the Redis singleton.
 * Lazily initialised on first call.
 * @returns {Redis | null}
 */
function getRedisClient() {
    if (client) return client;

    const REDIS_URL = process.env.REDIS_URL;

    if (!REDIS_URL) {
        logger.warn('[Redis] REDIS_URL not set – running WITHOUT Redis (in-memory fallback only)');
        return null;
    }

    client = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
        retryStrategy: (times) => {
            if (times > 5) {
                logger.error('[Redis] Max reconnection attempts reached');
                return null; // stop retrying
            }
            const delay = Math.min(times * 500, 3000);
            logger.warn(`[Redis] Reconnecting in ${delay}ms (attempt ${times})`);
            return delay;
        },
    });

    client.on('connect', () => {
        isConnected = true;
        if (process.env.DEBUG_NAVIGATION === 'true') logger.info('REDIS_CONNECTED');
        logger.info('[Redis] Connected successfully');
    });

    client.on('error', (err) => {
        isConnected = false;
        logger.warn('REDIS_DISCONNECTED', { error: err.message });
        logger.error('[Redis] Connection error:', err.message);
    });

    client.on('close', () => {
        isConnected = false;
        logger.warn('REDIS_DISCONNECTED', { reason: 'close' });
        logger.warn('[Redis] Connection closed');
    });

    client.on('reconnecting', () => {
        if (process.env.DEBUG_NAVIGATION === 'true') logger.info('REDIS_RECONNECT');
        logger.info('[Redis] Reconnecting...');
    });

    return client;
}

/**
 * Safe SET with optional TTL (seconds).
 * Falls back silently if Redis is not available.
 *
 * @param {string} key
 * @param {string|object} value - objects are JSON.stringified automatically
 * @param {number} [ttlSeconds] - expiry in seconds (optional)
 */
async function redisSet(key, value, ttlSeconds = null) {
    const redis = getRedisClient();
    if (!redis) return;

    const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);

    try {
        if (ttlSeconds) {
            await redis.set(key, serialized, 'EX', ttlSeconds);
        } else {
            await redis.set(key, serialized);
        }
    } catch (err) {
        logger.error(`[Redis] SET error for key "${key}":`, err.message);
    }
}

/**
 * Safe GET with automatic JSON parsing.
 * Falls back silently if Redis is not available.
 *
 * @param {string} key
 * @returns {any|null}
 */
async function redisGet(key) {
    const redis = getRedisClient();
    if (!redis) return null;

    try {
        const val = await redis.get(key);
        if (val === null) return null;

        try {
            return JSON.parse(val);
        } catch {
            return val; // plain string
        }
    } catch (err) {
        logger.error(`[Redis] GET error for key "${key}":`, err.message);
        return null;
    }
}

/**
 * Safe DELETE.
 * @param {...string} keys
 */
async function redisDel(...keys) {
    const redis = getRedisClient();
    if (!redis || keys.length === 0) return;

    try {
        await redis.del(...keys);
    } catch (err) {
        logger.error(`[Redis] DEL error for keys [${keys.join(', ')}]:`, err.message);
    }
}

/**
 * Acquire a distributed lock.
 * @param {string} resource
 * @param {number} ttlMs - lock expiry in milliseconds
 * @returns {Promise<boolean>} true if lock acquired, false otherwise
 */
async function redisLock(resource, ttlMs = 5000) {
    if (process.env.DEBUG_NAVIGATION === 'true') {
        logger.info('LOCK_ACQUIRE', { resource });
    }
    const redis = getRedisClient();
    if (!redis) return true; // bypass if redis offline
    const key = `lock:${resource}`;
    try {
        const result = await redis.set(key, 'locked', 'PX', ttlMs, 'NX');
        const locked = result === 'OK';
        if (process.env.DEBUG_NAVIGATION === 'true') {
            logger.info(locked ? 'LOCK_ACQUIRED' : 'LOCK_FAILED', { resource });
        }
        return locked;
    } catch (err) {
        if (process.env.DEBUG_NAVIGATION === 'true') logger.info('LOCK_FAILED', { resource });
        logger.error(`[Redis] LOCK error for key "${key}":`, err.message);
        return true; // fail-open so customer operations are not blocked
    }
}

/**
 * Release a distributed lock.
 * @param {string} resource
 */
async function redisUnlock(resource) {
    const redis = getRedisClient();
    if (!redis) return;
    const key = `lock:${resource}`;
    try {
        await redis.del(key);
        if (process.env.DEBUG_NAVIGATION === 'true') {
            logger.info('LOCK_RELEASED', { resource });
        }
    } catch (err) {
        logger.error(`[Redis] UNLOCK error for key "${key}":`, err.message);
    }
}

/**
 * Whether Redis is currently connected.
 * @returns {boolean}
 */
function isRedisReady() {
    return isConnected;
}

module.exports = {
    getRedisClient,
    redisSet,
    redisGet,
    redisDel,
    redisLock,
    redisUnlock,
    isRedisReady,
    
    // ─── PoD V2 Methods ──────────────────────────────────────────────────────────
    generateAndStoreHMAC,
    getPlainOTP,
    verifyHMACOTP,
    checkAndSetFraudHash
};

/**
 * Generate a 6-digit OTP, compute HMAC SHA256, and store in Redis.
 * Key: `delivery:otp:{sessionId}:v{otpVersion}`
 * @param {string} sessionId
 * @param {number} otpVersion
 * @returns {Promise<string>} The plaintext 6-digit OTP to send to the client.
 */
async function generateAndStoreHMAC(sessionId, otpVersion) {
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digits
    const secret = process.env.OTP_SECRET || 'mashawerr-super-secret-key-2026';
    const hmac = crypto.createHmac('sha256', secret).update(otp).digest('hex');
    
    const key = `delivery:otp:${sessionId}:v${otpVersion}`;
    const value = { hmac, attempts: 0 };
    
    // Store with 5 minutes TTL (300 seconds)
    await redisSet(key, value, 300);
    await redisSet(`delivery:otp_plain:${sessionId}:v${otpVersion}`, otp, 300);
    
    return otp;
}

/**
 * Get active plaintext OTP for customer view.
 * @param {string} sessionId
 * @param {number} otpVersion
 * @returns {Promise<string|null>}
 */
async function getPlainOTP(sessionId, otpVersion) {
    const key = `delivery:otp_plain:${sessionId}:v${otpVersion}`;
    return await redisGet(key);
}

/**
 * Verify an incoming plaintext OTP against the stored HMAC.
 * Handles rate limiting (max 5 attempts).
 * @param {string} sessionId
 * @param {number} otpVersion
 * @param {string} incomingOtp
 * @returns {Promise<{valid: boolean, reason?: string, attempts: number}>}
 */
async function verifyHMACOTP(sessionId, otpVersion, incomingOtp) {
    const key = `delivery:otp:${sessionId}:v${otpVersion}`;
    const data = await redisGet(key);
    
    if (!data) return { valid: false, reason: 'EXPIRED_OR_NOT_FOUND', attempts: 0 };
    if (data.attempts >= 5) return { valid: false, reason: 'LOCKED_MAX_ATTEMPTS', attempts: data.attempts };
    
    const secret = process.env.OTP_SECRET || 'mashawerr-super-secret-key-2026';
    const incomingHmac = crypto.createHmac('sha256', secret).update(incomingOtp).digest('hex');
    
    // Timing safe equal is best practice, but straight comparison is okay since it's an HMAC hex string.
    if (incomingHmac === data.hmac) {
        // Correct OTP. Clean it up so it can't be reused (Single-Use).
        await redisDel(key);
        return { valid: true, attempts: data.attempts + 1 };
    } else {
        // Wrong OTP. Increment attempts.
        data.attempts += 1;
        
        // Use raw ioredis to maintain the TTL instead of overwriting the whole key with a new TTL,
        // but for simplicity we will just read TTL and set it back.
        const redis = getRedisClient();
        if (redis) {
            const ttl = await redis.ttl(key);
            if (ttl > 0) {
                await redisSet(key, data, ttl);
            }
        }
        
        return { valid: false, reason: 'INVALID_OTP', attempts: data.attempts };
    }
}

/**
 * Check if a pHash already exists in Redis (Fraud Detection).
 * If not, sets it with a 30-day TTL.
 * @param {string} pHash
 * @returns {Promise<boolean>} true if it's a duplicate/fraud, false if it's clean.
 */
async function checkAndSetFraudHash(pHash) {
    if (!pHash) return false;
    
    const redis = getRedisClient();
    if (!redis) return false; // Bypass if redis is down
    
    const key = `fraud:phash:${pHash}`;
    const exists = await redis.get(key);
    
    if (exists) {
        return true; // Fraud detected!
    }
    
    // Store for 30 days (2592000 seconds)
    await redisSet(key, '1', 2592000);
    return false; // Clean
}

