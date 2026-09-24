const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * RefreshToken Schema
 *
 * Security Design:
 * - We store only the SHA-256 HASH of the refresh token, never the raw value.
 * - Each token belongs to a "family" (UUID). When a replay attack is detected
 *   (a revoked token is reused), the entire family is invalidated, forcing re-login.
 * - MongoDB TTL index auto-deletes expired tokens from the collection.
 */
const RefreshTokenSchema = new mongoose.Schema(
    {
        // SHA-256 hash of the actual refresh token JWT string
        tokenHash: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },

        // The user who owns this token
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },

        // Token family UUID – all tokens in a login session share the same family.
        // Used to detect replay attacks: if a revoked token is used again,
        // we invalidate ALL tokens in the family.
        family: {
            type: String,
            required: true,
            index: true,
        },

        // Whether this token has been explicitly revoked (rotated or logged out)
        isRevoked: {
            type: Boolean,
            default: false,
            index: true,
        },

        // The hash of the NEW token that replaced this one (rotation chain tracking)
        replacedByHash: {
            type: String,
            default: null,
        },

        // Token expiry timestamp – TTL index removes the document automatically
        expiresAt: {
            type: Date,
            required: true,
            index: { expires: 0 }, // MongoDB TTL: removes doc when expiresAt is reached
        },

        // Device/IP metadata for security audit
        ipAddress: { type: String, default: null },
        userAgent: { type: String, default: null },
    },
    { timestamps: true }
);

/**
 * Static helper: hash a raw refresh token string → SHA-256 hex
 */
RefreshTokenSchema.statics.hashToken = function (rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
};

/**
 * Static helper: revoke all tokens belonging to a family (replay attack response)
 */
RefreshTokenSchema.statics.revokeFamilyTokens = async function (family) {
    return this.updateMany({ family }, { $set: { isRevoked: true } });
};

const RefreshToken = mongoose.model('RefreshToken', RefreshTokenSchema);

module.exports = { RefreshToken };
