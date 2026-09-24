const mongoose = require('mongoose');

const DeliverySessionSchema = new mongoose.Schema(
    {
        sessionId: { type: String, required: true, unique: true },
        
        // Referencing either regular Order or StoreOrder
        orderId: { type: mongoose.Schema.Types.Mixed, required: true },
        
        // References to driver and customer
        driverId: { type: String, required: true },
        customerId: { type: String, required: true },
        
        // Phase: PICKUP vs DELIVERY photo approval
        phase: {
            type: String,
            enum: ['PICKUP', 'DELIVERY'],
            default: 'DELIVERY'
        },
        
        // Core session state machine
        state: {
            type: String,
            enum: ['IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED', 'SUPPORT_REQUIRED'],
            default: 'IN_PROGRESS'
        },
        subState: {
            type: String,
            enum: ['WAITING_DRIVER_UPLOAD', 'WAITING_AI', 'WAITING_CUSTOMER', 'WAITING_PICKUP_APPROVAL', 'PICKUP_APPROVED', 'WAITING_OTP', 'NONE'],
            default: 'WAITING_DRIVER_UPLOAD'
        },
        
        // For HMAC OTP Versioning
        otpVersion: { type: Number, default: 0 },
        activeOtpCode: { type: String, default: null },
        
        // Optimistic Concurrency Control (to prevent race conditions)
        version: { type: Number, default: 1 },
        
        // Sync identifier for socket state recovery
        lastEventId: { type: String, default: null },

        // Soft & Hard Expiration
        nextReminderAt: { type: Date, default: null },
        expiresAt: { type: Date, required: true }
    },
    { 
        timestamps: true,
    }
);

// We'll use Mongoose's built-in __v for versioning, but we mapped it conceptually in the plan to "version".
// Mongoose uses __v automatically when optimisticConcurrency: true is set.

const DeliverySession = mongoose.model('DeliverySession', DeliverySessionSchema);

module.exports = { DeliverySession };
