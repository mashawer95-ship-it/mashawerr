/**
 * redis/hrRedis.js
 * Redis helper functions for HR, shift management, and live representative tracking.
 */

const { redisGet, redisSet, redisDel, getRedisClient } = require('../config/redis');
const logger = require('../utils/logger');

// ── TTL Constants ──────────
const REP_SESSION_TTL   = 32400;  // 9 hours
const REP_ORDER_TTL     = 21600;  // 6 hours
const APPSTATE_TTL      = 300;    // 5 minutes (renewed by heartbeat)
const SHIFT_REPS_TTL    = 100800; // 28 hours (covers overnight shift duration + buffer)
const DASHBOARD_CACHE_TTL = 30;   // 30 seconds
const ACTIVE_SHIFTS_TTL = 300;   // 5 minutes

// ── Key Builders ───────────
const k = {
    repSession:    (repId) => `hr:rep:${repId}:session`,
    repOrder:      (repId) => `hr:rep:${repId}:order`,
    repAppState:   (repId) => `hr:rep:${repId}:appstate`,
    shiftRepsSet:  (shiftId) => `hr:shift:${shiftId}:reps`,
    liveDashboard: `hr:live:dashboard`,
    activeShifts:  `hr:shifts:active`,
};

// ── Session Operations ─────

async function setRepSession(repId, sessionData, ttl = REP_SESSION_TTL) {
    await redisSet(k.repSession(repId), sessionData, ttl);
}

async function getRepSession(repId) {
    return redisGet(k.repSession(repId));
}

async function clearRepSession(repId) {
    await redisDel(k.repSession(repId));
}

// ── AppState Operations (open / closed) ──

async function setRepAppState(repId, state = 'open', ttl = APPSTATE_TTL) {
    await redisSet(k.repAppState(repId), { state, lastSeen: Date.now() }, ttl);
}

async function getRepAppState(repId) {
    return redisGet(k.repAppState(repId));
}

async function touchRepAppState(repId, ttl = APPSTATE_TTL) {
    const redis = getRedisClient();
    if (!redis) return;
    try {
        const current = await redisGet(k.repAppState(repId)) || { state: 'open' };
        current.lastSeen = Date.now();
        await redisSet(k.repAppState(repId), current, ttl);
    } catch (err) {
        logger.error(`[hrRedis] touchRepAppState error for ${repId}: ${err.message}`);
    }
}

// ── Current Order Operations ──

async function setRepCurrentOrder(repId, orderData, ttl = REP_ORDER_TTL) {
    await redisSet(k.repOrder(repId), orderData, ttl);
}

async function getRepCurrentOrder(repId) {
    return redisGet(k.repOrder(repId));
}

async function clearRepCurrentOrder(repId) {
    await redisDel(k.repOrder(repId));
}

// ── Shift Rep Set Operations ──

async function addRepToShiftSet(shiftId, repId) {
    const redis = getRedisClient();
    if (!redis) return;
    try {
        const key = k.shiftRepsSet(shiftId);
        await redis.sadd(key, repId.toString());
        await redis.expire(key, SHIFT_REPS_TTL);
    } catch (err) {
        logger.error(`[hrRedis] addRepToShiftSet error: ${err.message}`);
    }
}

async function removeRepFromShiftSet(shiftId, repId) {
    const redis = getRedisClient();
    if (!redis) return;
    try {
        await redis.srem(k.shiftRepsSet(shiftId), repId.toString());
    } catch (err) {
        logger.error(`[hrRedis] removeRepFromShiftSet error: ${err.message}`);
    }
}

async function getShiftRepSet(shiftId) {
    const redis = getRedisClient();
    if (!redis) return [];
    try {
        return await redis.smembers(k.shiftRepsSet(shiftId));
    } catch (err) {
        logger.error(`[hrRedis] getShiftRepSet error: ${err.message}`);
        return [];
    }
}

// ── Live Dashboard Cache Operations ──

async function cacheLiveDashboard(dashboardData, ttl = DASHBOARD_CACHE_TTL) {
    await redisSet(k.liveDashboard, dashboardData, ttl);
}

async function getCachedLiveDashboard() {
    return redisGet(k.liveDashboard);
}

async function invalidateLiveDashboard() {
    await redisDel(k.liveDashboard);
}

// ── Active Shifts Cache Operations ──

async function cacheActiveShifts(shiftsData, ttl = ACTIVE_SHIFTS_TTL) {
    await redisSet(k.activeShifts, shiftsData, ttl);
}

async function getCachedActiveShifts() {
    return redisGet(k.activeShifts);
}

async function invalidateActiveShifts() {
    await redisDel(k.activeShifts);
}

module.exports = {
    setRepSession,
    getRepSession,
    clearRepSession,
    setRepAppState,
    getRepAppState,
    touchRepAppState,
    setRepCurrentOrder,
    getRepCurrentOrder,
    clearRepCurrentOrder,
    addRepToShiftSet,
    removeRepFromShiftSet,
    getShiftRepSet,
    cacheLiveDashboard,
    getCachedLiveDashboard,
    invalidateLiveDashboard,
    cacheActiveShifts,
    getCachedActiveShifts,
    invalidateActiveShifts,
    _keys: k,
};
