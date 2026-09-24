const mongoose = require('mongoose');

/**
 * BannedDevice Schema
 * Stores banned hardware identifiers, FCM tokens, phone numbers, and emails
 * of deleted or blocked users to prevent re-registration on Mashawerr platform.
 */
const bannedDeviceSchema = new mongoose.Schema(
    {
        phone: {
            type: String,
            trim: true,
            index: true,
            sparse: true,
        },
        fcmToken: {
            type: String,
            trim: true,
            index: true,
            sparse: true,
        },
        deviceId: {
            type: String,
            trim: true,
            index: true,
            sparse: true,
        },
        email: {
            type: String,
            trim: true,
            lowercase: true,
            index: true,
            sparse: true,
        },
        originalUserId: {
            type: String,
            trim: true,
            index: true,
        },
        userName: {
            type: String,
            trim: true,
        },
        profileImage: {
            type: String,
            trim: true,
        },
        userType: {
            type: String,
            trim: true,
        },
        reason: {
            type: String,
            enum: ['ACCOUNT_DELETED_BY_ADMIN', 'ACCOUNT_BLOCKED_BY_ADMIN', 'MANUAL_ADMIN_BAN', 'DEVICE_BLOCKED_BY_ADMIN'],
            default: 'ACCOUNT_DELETED_BY_ADMIN',
        },
        bannedBy: {
            type: String,
            default: 'SYSTEM_ADMIN',
        },
        isActive: {
            type: Boolean,
            default: true,
            index: true,
        },
        meta: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
    },
    {
        timestamps: true,
    }
);

// Compound index for ultra-fast multi-vector checks
bannedDeviceSchema.index({ phone: 1, isActive: 1 });
bannedDeviceSchema.index({ fcmToken: 1, isActive: 1 });
bannedDeviceSchema.index({ deviceId: 1, isActive: 1 });
bannedDeviceSchema.index({ email: 1, isActive: 1 });

module.exports = mongoose.model('BannedDevice', bannedDeviceSchema);
