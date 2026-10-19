/**
 * rateLimiter.js
 * Express rate-limiting middleware for ride-tracking endpoints.
 *
 * Prevents drivers from flooding the location endpoint
 * and protects against brute-force/DDoS attacks.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const logger = require('../utils/logger');

/**
 * Shared Redis store so limits are enforced across ALL API instances.
 * Falls back to the default in-memory store if Redis / rate-limit-redis is unavailable.
 */
function buildStore(prefix) {
    try {
        const { getRedisClient } = require('../config/redis');
        const client = getRedisClient();
        if (!client) return undefined;
        const { RedisStore } = require('rate-limit-redis');
        return new RedisStore({
            prefix: `rl:${prefix}:`,
            sendCommand: (...args) => client.call(...args),
        });
    } catch (_) {
        return undefined;
    }
}

/**
 * Login / register / social sign-in: brute-force & credential-stuffing protection.
 * Keyed by IP + email so shared mobile-carrier NATs are not punished too hard.
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 30,
    standardHeaders: true,
    legacyHeaders: false,
    store: buildStore('auth'),
    passOnStoreError: true,
    keyGenerator: (req, res) => {
        const email = req.body?.email ? String(req.body.email).toLowerCase().trim() : '';
        return `${ipKeyGenerator(req, res)}|${email}`;
    },
    handler: (req, res) => {
        logger.warn(`[RateLimit] Auth limit exceeded for: ${req.body?.email || req.ip}`);
        res.status(429).json({
            success: false,
            message: 'محاولات كثيرة جداً. يرجى الانتظار قليلاً ثم المحاولة مرة أخرى.',
            retryAfterMinutes: 15,
        });
    },
});

/** Refresh-token endpoint: generous but bounded (clients refresh rarely). */
const refreshTokenLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.REFRESH_RATE_LIMIT_MAX) || 30,
    standardHeaders: true,
    legacyHeaders: false,
    store: buildStore('refresh'),
    passOnStoreError: true,
    keyGenerator: (req, res) => ipKeyGenerator(req, res),
    handler: (req, res) => {
        res.status(429).json({ success: false, message: 'Too many token refresh requests.' });
    },
});

/**
 * Strict limiter for driver location updates.
 * Drivers should call this endpoint every 5-10 seconds.
 * Allows up to 30 requests per minute (generous for 5s interval = 12/min per driver).
 */
const locationUpdateLimiter = rateLimit({
    windowMs: 60 * 1000,         // 1 minute window
    max: 30,                     // max 30 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => {
        // Key by driver ID (from JWT) or fall back to IP using the official helper
        return req.user?.id || ipKeyGenerator(req, res);
    },
    handler: (req, res) => {
        logger.warn(`[RateLimit] Location update rate limit exceeded for driver: ${req.user?.id || req.ip}`);
        res.status(429).json({
            success: false,
            message: 'Too many location updates. Please wait before sending again.',
            retryAfterMs: 60000,
        });
    },
});

/**
 * General API limiter for trip management endpoints (start/end/status).
 * More lenient — allows up to 60 requests per minute.
 */
const tripApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
    handler: (req, res) => {
        logger.warn(`[RateLimit] Trip API rate limit exceeded for: ${req.user?.id || req.ip}`);
        res.status(429).json({
            success: false,
            message: 'Too many requests. Please slow down.',
        });
    },
});

/**
 * PoD V2: Strict OTP Rate Limiting.
 * Max 5 attempts per 5 minutes per IP or user.
 */
const otpVerificationLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
    handler: (req, res) => {
        logger.warn(`[RateLimit] OTP verification brute force attempt blocked: ${req.user?.id || req.ip}`);
        res.status(429).json({
            success: false,
            message: 'Too many failed OTP attempts. Please wait 5 minutes or generate a new OTP.',
        });
    },
});

/**
 * Password Reset Rate Limiter: Max 3 requests per 15 minutes.
 * Prevents account enumeration, spamming email servers, and brute-force attacks.
 */
const passwordResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => {
        const email = req.body?.email ? String(req.body.email).toLowerCase().trim() : '';
        return email ? `pwd_reset_${email}` : ipKeyGenerator(req, res);
    },
    handler: (req, res) => {
        logger.warn(`[RateLimit] Password reset limit exceeded for: ${req.body?.email || req.ip}`);
        res.status(429).json({
            success: false,
            message: 'لقد تجاوزت عدد المحاولات المسموح بها لإعادة تعيين كلمة المرور. يرجى الانتظار 15 دقيقة والتجربة مرة أخرى.',
            retryAfterMinutes: 15,
        });
    },
});

/**
 * Email Verification Rate Limiter: Max 5 requests per 15 minutes.
 */
const emailVerificationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => {
        const email = req.body?.email ? String(req.body.email).toLowerCase().trim() : '';
        return email ? `email_ver_${email}` : ipKeyGenerator(req, res);
    },
    handler: (req, res) => {
        logger.warn(`[RateLimit] Email verification limit exceeded for: ${req.body?.email || req.ip}`);
        res.status(429).json({
            success: false,
            message: 'تم تجاوز عدد محاولات إرسال/تأكيد البريد الإلكتروني. يرجى الانتظار 15 دقيقة.',
            retryAfterMinutes: 15,
        });
    },
});

/**
 * Maps Proxy Rate Limiter:
 * Up to 120 requests per minute per user/IP. Prevents abuse/scraping while allowing smooth autocomplete.
 */
const mapsProxyLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.MAPS_RATE_LIMIT_MAX) || 120,
    standardHeaders: true,
    legacyHeaders: false,
    store: buildStore('maps'),
    passOnStoreError: true,
    keyGenerator: (req, res) => req.user?.id || ipKeyGenerator(req, res),
    handler: (req, res) => {
        logger.warn(`[RateLimit] Maps proxy limit exceeded for: ${req.user?.id || req.ip}`);
        res.status(429).json({
            status: 'OVER_QUERY_LIMIT',
            success: false,
            message: 'Too many map requests. Please slow down.',
        });
    },
});

module.exports = {
    locationUpdateLimiter,
    tripApiLimiter,
    otpVerificationLimiter,
    passwordResetLimiter,
    emailVerificationLimiter,
    authLimiter,
    refreshTokenLimiter,
    mapsProxyLimiter,
};
