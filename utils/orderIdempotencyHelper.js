/**
 * utils/orderIdempotencyHelper.js
 * Production-Grade Idempotency Engine for Order Creation (POST /api/orders).
 *
 * Guarantees:
 *  1. Exactly-once order creation under high concurrency.
 *  2. In-flight request locking via Redis SET NX with auto-expiring lease.
 *  3. In-flight contention polling: concurrent requests wait briefly and receive the completed result.
 *  4. Permanent ground-truth persistence in MongoDB (Order.idempotencyKey + Order.idempotencyPayloadHash).
 *  5. Graceful recovery on server crash or Redis failure/restart.
 *  6. Request payload fingerprinting: detects and rejects key reuse with altered payloads (HTTP 422).
 *  7. Strict user scoping: prevent IDOR or cross-user key collision.
 *  8. Safe DB-level fallback via compound unique index on (clientId, idempotencyKey).
 */

'use strict';

const crypto = require('crypto');
const logger = require('./logger');
const { getRedisClient, redisGet, redisSet, redisDel, redisSetNxPx } = require('../config/redis');

/** Default TTL for in-flight processing lock (milliseconds) */
const IN_FLIGHT_LOCK_TTL_MS = 45000;

/** Default TTL for completed idempotency cache in Redis (seconds: 24 hours) */
const COMPLETED_CACHE_TTL_SECONDS = 86400;

/** Max wait time for in-flight polling before returning 409 (milliseconds) */
const MAX_IN_FLIGHT_WAIT_MS = 2500;
const POLL_INTERVAL_MS = 200;

/**
 * Recursively sort object keys and normalize values to generate a canonical payload.
 * Excludes transient client fields like requestId, timestamp, or tracking query params.
 *
 * @param {any} val
 * @returns {any}
 */
function canonicalizePayload(val) {
    if (val === null || val === undefined) return null;
    if (typeof val !== 'object') {
        if (typeof val === 'string') return val.trim();
        if (typeof val === 'number') return Number(val);
        return val;
    }
    if (val instanceof Date) return val.toISOString();
    if (Array.isArray(val)) {
        return val.map(canonicalizePayload);
    }
    const sortedKeys = Object.keys(val).sort();
    const result = {};
    for (const k of sortedKeys) {
        // Exclude transient/ephemeral request-tracing fields
        if (k === 'requestId' || k === 'timestamp' || k === 'reqId' || k === '_t') continue;
        result[k] = canonicalizePayload(val[k]);
    }
    return result;
}

/**
 * Computes a SHA-256 fingerprint hash of the request payload.
 *
 * @param {object} payload
 * @returns {string} hex-encoded SHA-256 hash
 */
function computePayloadHash(payload) {
    const canonical = canonicalizePayload(payload || {});
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Generates user-scoped Redis key for order idempotency.
 *
 * @param {string} userId
 * @param {string} idempotencyKey
 * @returns {string}
 */
function getRedisIdempotencyKey(userId, idempotencyKey) {
    const safeUser = String(userId || 'anonymous').trim();
    const safeKey = String(idempotencyKey || '').trim();
    return `idempotency:order:${safeUser}:${safeKey}`;
}

/**
 * Pre-check: Check if this idempotency key was ALREADY COMPLETED either in Redis or MongoDB.
 *
 * @param {object} params
 * @param {object} params.req - Express req
 * @param {string} params.userId - Authenticated user / client ID
 * @param {string} params.idempotencyKey - Client-provided idempotency key
 * @param {object} params.payload - Request payload
 * @returns {Promise<object|null>} cached result or mismatch error, or null if not yet completed
 */
async function getCompletedIdempotency({ req, userId, idempotencyKey, payload }) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') return null;
    const trimmedKey = idempotencyKey.trim();
    if (!trimmedKey) return null;

    const payloadHash = computePayloadHash(payload);
    const redis = getRedisClient();
    const redisKey = getRedisIdempotencyKey(userId, trimmedKey);

    // ── 1. Check Redis Cache ─────────────────────────────────────────────────
    if (redis) {
        try {
            const cached = await redisGet(redisKey);
            if (cached && cached.status === 'COMPLETED') {
                if (cached.payloadHash && cached.payloadHash !== payloadHash) {
                    return {
                        state: 'MISMATCH',
                        error: {
                            status: 422,
                            code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
                            message: 'تم استخدام مفتاح العملية (Idempotency-Key) مسبقاً مع بيانات طلب مختلفة.',
                        },
                    };
                }
                return { state: 'COMPLETED', response: cached.response, source: 'redis' };
            }
        } catch (err) {
            logger.warn(`[Idempotency] Redis getCompleted error for ${redisKey}: ${err.message}`);
        }
    }

    // ── 2. Check MongoDB Durable Record (Fallback if Redis expired/restarted) ─
    try {
        const { Order } = require('../middlewares/Order');
        const existingOrder = await Order.findOne({
            clientId: String(userId),
            idempotencyKey: trimmedKey,
        });

        if (existingOrder) {
            if (existingOrder.idempotencyPayloadHash && existingOrder.idempotencyPayloadHash !== payloadHash) {
                return {
                    state: 'MISMATCH',
                    error: {
                        status: 422,
                        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
                        message: 'تم استخدام مفتاح العملية (Idempotency-Key) مسبقاً مع بيانات طلب مختلفة.',
                    },
                };
            }

            // Re-format using standard order formatter
            const { formatOrder, enrichOrdersWithVehicleData } = require('../Controllers/orderController');
            const { getCachedRepCommission } = require('../middlewares/RepCommission');
            const commissionCfg = await getCachedRepCommission().catch(() => null);
            let [formatted] = await enrichOrdersWithVehicleData(req, [formatOrder(req, existingOrder, commissionCfg)]);

            // Re-populate Redis so subsequent calls hit the fast path
            if (redis) {
                await redisSet(redisKey, {
                    status: 'COMPLETED',
                    payloadHash,
                    response: formatted,
                    orderId: existingOrder.orderId,
                    orderMongoId: String(existingOrder._id),
                    completedAt: existingOrder.createdAt ? existingOrder.createdAt.toISOString() : new Date().toISOString(),
                }, COMPLETED_CACHE_TTL_SECONDS).catch(() => {});
            }

            return { state: 'COMPLETED', response: formatted, source: 'mongodb' };
        }
    } catch (err) {
        logger.error(`[Idempotency] MongoDB check error: ${err.message}`);
    }

    return null;
}

/**
 * Acquire in-flight processing lock in Redis.
 * If another request is currently processing, it waits up to MAX_IN_FLIGHT_WAIT_MS.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.idempotencyKey
 * @param {object} params.payload
 * @param {number} [params.ttlMs] - Lock TTL in ms
 * @returns {Promise<object>} { state: 'LOCKED' | 'COMPLETED' | 'IN_PROGRESS' | 'MISMATCH' | 'INVALID_KEY' }
 */
async function acquireInFlightLock({ req, userId, idempotencyKey, payload, ttlMs = IN_FLIGHT_LOCK_TTL_MS }) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
        return { state: 'NO_KEY' };
    }

    const trimmedKey = idempotencyKey.trim();
    if (trimmedKey.length === 0 || trimmedKey.length > 255) {
        return {
            state: 'INVALID_KEY',
            error: {
                status: 400,
                code: 'INVALID_IDEMPOTENCY_KEY',
                message: 'مفتاح العملية (Idempotency-Key) غير صالح. يجب أن يكون نصاً بين 1 و 255 حرفاً.',
            },
        };
    }

    const payloadHash = computePayloadHash(payload);
    const redisKey = getRedisIdempotencyKey(userId, trimmedKey);

    try {
        const lockPayload = JSON.stringify({
            status: 'PROCESSING',
            payloadHash,
            lockedAt: new Date().toISOString(),
        });

        // SET key value PX ttlMs NX (atomic reservation)
        const setRes = await redisSetNxPx(redisKey, lockPayload, ttlMs);
        if (setRes === 'OK') {
            return {
                state: 'LOCKED',
                payloadHash,
                idempotencyKey: trimmedKey,
                redisKey,
            };
        }

        // Lock already held: check what is in Redis/cache
        const existingVal = await redisGet(redisKey);
        if (existingVal && existingVal.status === 'COMPLETED') {
            if (existingVal.payloadHash && existingVal.payloadHash !== payloadHash) {
                return {
                    state: 'MISMATCH',
                    error: {
                        status: 422,
                        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
                        message: 'تم استخدام مفتاح العملية (Idempotency-Key) مسبقاً مع بيانات طلب مختلفة.',
                    },
                };
            }
            return { state: 'COMPLETED', response: existingVal.response, source: 'redis' };
        }

        // Another request is actively PROCESSING. Poll briefly to see if it completes.
        const startTime = Date.now();
        while (Date.now() - startTime < MAX_IN_FLIGHT_WAIT_MS) {
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
            const pollVal = await redisGet(redisKey);
            if (!pollVal) {
                // Lock expired or was released on error. Try acquiring again.
                const retrySet = await redisSetNxPx(redisKey, lockPayload, ttlMs);
                if (retrySet === 'OK') {
                    return {
                        state: 'LOCKED',
                        payloadHash,
                        idempotencyKey: trimmedKey,
                        redisKey,
                    };
                }
            } else if (pollVal.status === 'COMPLETED') {
                if (pollVal.payloadHash && pollVal.payloadHash !== payloadHash) {
                    return {
                        state: 'MISMATCH',
                        error: {
                            status: 422,
                            code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
                            message: 'تم استخدام مفتاح العملية (Idempotency-Key) مسبقاً مع بيانات طلب مختلفة.',
                        },
                    };
                }
                return { state: 'COMPLETED', response: pollVal.response, source: 'redis' };
            }
        }

        // Still in progress after wait
        return {
            state: 'IN_PROGRESS',
            error: {
                status: 409,
                code: 'ORDER_CREATION_IN_PROGRESS',
                message: 'طلبك قيد المعالجة حالياً، يرجى الانتظار ثانية والمحاولة مرة أخرى.',
                retryable: true,
            },
        };
    } catch (err) {
        logger.warn(`[Idempotency] acquireInFlightLock error for ${redisKey}: ${err.message}`);
        return {
            state: 'LOCKED',
            payloadHash,
            idempotencyKey: trimmedKey,
            redisKey,
        };
    }
}

/**
 * Record successful completion of order creation in Redis.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.idempotencyKey
 * @param {string} params.payloadHash
 * @param {object} params.response - Formatted order JSON returned to client
 * @param {number|string} [params.orderId]
 * @param {string} [params.orderMongoId]
 * @param {number} [params.ttlSeconds]
 */
async function recordIdempotencySuccess({
    userId,
    idempotencyKey,
    payloadHash,
    response,
    orderId,
    orderMongoId,
    ttlSeconds = COMPLETED_CACHE_TTL_SECONDS,
}) {
    if (!idempotencyKey) return;
    const redis = getRedisClient();
    if (!redis) return;

    const redisKey = getRedisIdempotencyKey(userId, idempotencyKey);
    try {
        await redisSet(
            redisKey,
            {
                status: 'COMPLETED',
                payloadHash,
                response,
                orderId: orderId || response?.orderId,
                orderMongoId: orderMongoId || response?._id,
                completedAt: new Date().toISOString(),
            },
            ttlSeconds
        );
    } catch (err) {
        logger.error(`[Idempotency] recordIdempotencySuccess failed for ${redisKey}: ${err.message}`);
    }
}

/**
 * Release in-flight processing lock in Redis.
 * Only deletes if status is currently 'PROCESSING' (never deletes 'COMPLETED').
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.idempotencyKey
 */
async function releaseIdempotencyLock({ userId, idempotencyKey }) {
    if (!idempotencyKey) return;
    const redisKey = getRedisIdempotencyKey(userId, idempotencyKey);
    try {
        const current = await redisGet(redisKey);
        if (current && current.status === 'PROCESSING') {
            await redisDel(redisKey);
        }
    } catch (err) {
        logger.warn(`[Idempotency] releaseIdempotencyLock error for ${redisKey}: ${err.message}`);
    }
}

module.exports = {
    canonicalizePayload,
    computePayloadHash,
    getRedisIdempotencyKey,
    getCompletedIdempotency,
    acquireInFlightLock,
    recordIdempotencySuccess,
    releaseIdempotencyLock,
    IN_FLIGHT_LOCK_TTL_MS,
    COMPLETED_CACHE_TTL_SECONDS,
};
