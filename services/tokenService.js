/**
 * tokenService.js
 *
 * Centralized JWT token lifecycle management for Mashawerr API.
 *
 * Security principles:
 *  1. Access Token  – short-lived (10 min), proves WHO the user is.
 *  2. Refresh Token – long-lived (4 months), stored hashed in DB, rotated on every use.
 *  3. Token Family  – every login session gets a UUID family. Replay attack on a
 *                     revoked refresh token immediately revokes the entire family.
 *  4. Logout        – revokes the current refresh token in DB (hard invalidation).
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { RefreshToken } = require('../models/RefreshToken');
const { User } = require('../middlewares/User');

// ─── Configuration ────────────────────────────────────────────────────────────
const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET  || process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
const ACCESS_EXPIRES  = process.env.JWT_ACCESS_EXPIRES  || '10m';
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES || '120d';

// Convert REFRESH_EXPIRES string to milliseconds for DB expiresAt field
function refreshExpiresMs() {
    const str = REFRESH_EXPIRES;
    const num = parseInt(str, 10);
    if (str.endsWith('d')) return num * 24 * 60 * 60 * 1000;
    if (str.endsWith('h')) return num * 60 * 60 * 1000;
    if (str.endsWith('m')) return num * 60 * 1000;
    return 120 * 24 * 60 * 60 * 1000; // default 120 days
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function hashToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// ─── Access Token ─────────────────────────────────────────────────────────────

/**
 * Generate a short-lived Access Token.
 * Payload: { id, isAdmin, userType }
 */
function generateAccessToken(user) {
    const payload = {
        id:       String(user._id || user.id),
        isAdmin:  !!user.isAdmin,
        userType: user.userType || 'NormalUser',
    };
    return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRES });
}

/**
 * Verify an Access Token.
 * Throws on invalid / expired.
 */
function verifyAccessToken(token) {
    return jwt.verify(token, ACCESS_SECRET);
}

// ─── Refresh Token ────────────────────────────────────────────────────────────

/**
 * Generate a new Refresh Token, persist its hash to DB, and return the raw token.
 *
 * @param {string|ObjectId} userId
 * @param {string|null}     family   – pass existing family for rotation, null for new login
 * @param {object}          meta     – optional { ipAddress, userAgent }
 * @returns {Promise<string>}  raw refresh token string
 */
async function generateRefreshToken(userId, family = null, meta = {}) {
    const tokenFamily = family || uuidv4();
    const expiresAt   = new Date(Date.now() + refreshExpiresMs());

    // Sign the JWT refresh token (contains only userId + family, NOT role info)
    const rawToken = jwt.sign(
        { id: String(userId), family: tokenFamily, type: 'refresh' },
        REFRESH_SECRET,
        { expiresIn: REFRESH_EXPIRES }
    );

    const tokenHash = hashToken(rawToken);

    // Persist the hash to DB
    await RefreshToken.create({
        tokenHash,
        userId:    String(userId),
        family:    tokenFamily,
        expiresAt,
        ipAddress: meta.ipAddress || null,
        userAgent: meta.userAgent ? meta.userAgent.substring(0, 200) : null,
    });

    // Update the user's active family reference
    await User.findByIdAndUpdate(userId, { refreshTokenFamily: tokenFamily });

    return rawToken;
}

/**
 * Rotate a Refresh Token:
 *   1. Verify the raw token JWT signature + expiry
 *   2. Look it up in DB by hash → must exist and not be revoked
 *   3. If token is already revoked → REPLAY ATTACK → revoke entire family
 *   4. Mark old token as revoked + replacedByHash
 *   5. Issue new access token + new refresh token (same family)
 *
 * @param {string} rawToken      – the raw refresh token from the client
 * @param {object} meta          – optional { ipAddress, userAgent }
 * @returns {Promise<{ accessToken: string, refreshToken: string, user: object }>}
 */
async function rotateRefreshToken(rawToken, meta = {}) {
    // Step 1: Verify JWT signature + expiry
    let decoded;
    try {
        decoded = jwt.verify(rawToken, REFRESH_SECRET);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            throw Object.assign(new Error('Refresh token expired. Please log in again.'), { code: 'REFRESH_TOKEN_EXPIRED' });
        }
        throw Object.assign(new Error('Invalid refresh token.'), { code: 'REFRESH_TOKEN_INVALID' });
    }

    if (decoded.type !== 'refresh') {
        throw Object.assign(new Error('Invalid token type.'), { code: 'REFRESH_TOKEN_INVALID' });
    }

    // Step 2: Look up by hash
    const tokenHash = hashToken(rawToken);
    const storedToken = await RefreshToken.findOne({ tokenHash });

    if (!storedToken) {
        throw Object.assign(new Error('Refresh token not found.'), { code: 'REFRESH_TOKEN_INVALID' });
    }

    // Step 3: Replay attack detection
    if (storedToken.isRevoked) {
        console.warn(`[TokenService] ⚠️ REPLAY ATTACK DETECTED – family: ${storedToken.family}, user: ${storedToken.userId}`);
        // Revoke the entire family → force re-login
        await RefreshToken.revokeFamilyTokens(storedToken.family);
        await User.findByIdAndUpdate(storedToken.userId, { refreshTokenFamily: null });
        throw Object.assign(
            new Error('Security alert: refresh token reuse detected. All sessions have been invalidated. Please log in again.'),
            { code: 'REPLAY_ATTACK_DETECTED' }
        );
    }

    // Step 4: Revoke the old token
    const newRawToken = jwt.sign(
        { id: String(storedToken.userId), family: storedToken.family, type: 'refresh' },
        REFRESH_SECRET,
        { expiresIn: REFRESH_EXPIRES }
    );
    const newTokenHash = hashToken(newRawToken);

    storedToken.isRevoked      = true;
    storedToken.replacedByHash = newTokenHash;
    await storedToken.save();

    // Step 5: Persist the new refresh token (same family)
    const expiresAt = new Date(Date.now() + refreshExpiresMs());
    await RefreshToken.create({
        tokenHash:  newTokenHash,
        userId:     storedToken.userId,
        family:     storedToken.family,
        expiresAt,
        ipAddress:  meta.ipAddress || null,
        userAgent:  meta.userAgent ? meta.userAgent.substring(0, 200) : null,
    });

    // Step 6: Fetch user + generate new access token
    const user = await User.findById(storedToken.userId);
    if (!user) {
        throw Object.assign(new Error('User not found.'), { code: 'USER_NOT_FOUND' });
    }
    if (user.isSuspended || user.status === 'blocked') {
        throw Object.assign(new Error('Account suspended.'), { code: 'ACCOUNT_SUSPENDED' });
    }

    const accessToken = generateAccessToken(user);

    return {
        accessToken,
        refreshToken: newRawToken,
        user,
    };
}

/**
 * Revoke a specific refresh token (used on logout).
 * @param {string} rawToken
 */
async function revokeRefreshToken(rawToken) {
    const tokenHash = hashToken(rawToken);
    await RefreshToken.findOneAndUpdate({ tokenHash }, { $set: { isRevoked: true } });
}

/**
 * Revoke ALL refresh tokens for a user (used on password change or admin force-logout).
 * @param {string|ObjectId} userId
 */
async function revokeAllUserTokens(userId) {
    await RefreshToken.updateMany({ userId: String(userId), isRevoked: false }, { $set: { isRevoked: true } });
    await User.findByIdAndUpdate(userId, { refreshTokenFamily: null });
}

module.exports = {
    generateAccessToken,
    verifyAccessToken,
    generateRefreshToken,
    rotateRefreshToken,
    revokeRefreshToken,
    revokeAllUserTokens,
    ACCESS_EXPIRES,
    REFRESH_EXPIRES,
};
