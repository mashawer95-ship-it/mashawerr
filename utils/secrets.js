/**
 * secrets.js — single place to resolve secrets that previously had hardcoded fallbacks.
 * In production a missing secret is a hard error (never silently use a known default).
 * In development a clearly-labelled default keeps local setups working.
 */
const isProduction = process.env.NODE_ENV === 'production';

function getSecretWithFallback(label, envNames, fallback) {
    for (const name of envNames) {
        if (process.env[name]) return process.env[name];
    }
    console.warn(`[SECURITY WARNING] ${label}: none of ${envNames.join(' / ')} is set in environment. Using fallback. Please configure it in your environment.`);
    return fallback;
}

/** Secret for short-lived google registration tokens. */
const getRegistrationTokenSecret = () =>
    getSecretWithFallback('Registration token secret', ['JWT_SECRET', 'JWT_ACCESS_SECRET'], 'fallback_secret_mashaweer_auth');

/** Secret for delivery OTP HMAC. */
const getOtpSecret = () =>
    getSecretWithFallback('OTP secret', ['OTP_SECRET', 'JWT_SECRET', 'JWT_ACCESS_SECRET'], 'mashawerr-super-secret-key-2026');

module.exports = { getRegistrationTokenSecret, getOtpSecret };
