const mongoose = require('mongoose');

const DeliveryAttemptSchema = new mongoose.Schema(
    {
        attemptId: { type: String, required: true, unique: true },
        sessionId: { type: String, required: true }, // Refers to DeliverySession.sessionId
        
        // e.g. 1, 2, 3... used to enforce the 3 or 5 attempts limit
        attemptNumber: { type: Number, required: true },
        
        // Phase: PICKUP vs DELIVERY
        phase: {
            type: String,
            enum: ['PICKUP', 'DELIVERY'],
            default: 'DELIVERY'
        },

        taskId: { type: String, default: null },
        stopIndex: { type: Number, default: null },
        itemIndex: { type: Number, default: null },
        productId: { type: String, default: null },
        
        state: {
            type: String,
            enum: ['UPLOADING', 'AI_VALIDATION', 'WAITING_CUSTOMER_REVIEW', 'APPROVED', 'REJECTED', 'AI_REJECTED'],
            default: 'UPLOADING'
        },
        
        photo: {
            photoId: { type: String, default: null },
            bucket: { type: String, default: null },
            objectKey: { type: String, default: null },
            cdnUrl: { type: String, default: null },
            checksumSha256: { type: String, default: null },
            pHash: { type: String, default: null },
            mimeType: { type: String, default: null },
            width: { type: Number, default: null },
            height: { type: Number, default: null },
            size: { type: Number, default: null }
        },
        
        metadata: {
            gps: {
                lat: { type: Number, default: null },
                lng: { type: Number, default: null },
            },
            heading: { type: Number, default: null },
            accuracy: { type: Number, default: null },
            timestamp: { type: Date, default: null },
            device: {
                deviceId: { type: String, default: null },
                appVersion: { type: String, default: null },
                platform: { type: String, default: null },
                buildNumber: { type: String, default: null }
            }
        },
        
        rejectionReason: {
            type: String,
            enum: ['WRONG_ITEM', 'DAMAGED', 'MISSING', 'NOT_CLEAR', 'AI_BLURRY', 'AI_BLACK', 'OTHER'],
            default: null
        }
    },
    { timestamps: true }
);

const DeliveryAttempt = mongoose.model('DeliveryAttempt', DeliveryAttemptSchema);

module.exports = { DeliveryAttempt };
