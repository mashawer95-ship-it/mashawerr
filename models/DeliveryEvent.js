const mongoose = require('mongoose');

const DeliveryEventSchema = new mongoose.Schema(
    {
        eventId: { type: String, required: true, unique: true },
        sessionId: { type: String, required: true, index: true }, // Refers to DeliverySession.sessionId
        traceId: { type: String, required: true }, // Correlation ID
        
        actor: { type: String, required: true }, // e.g. DRIVER, CUSTOMER, SYSTEM, AI
        action: { type: String, required: true }, // e.g. ATTEMPT_CREATED, OTP_GENERATED
        
        payload: { type: mongoose.Schema.Types.Mixed, default: {} },
        
        timestamp: { type: Date, default: Date.now, index: true }
    },
    { timestamps: false }
);

const DeliveryEvent = mongoose.model('DeliveryEvent', DeliveryEventSchema);

module.exports = { DeliveryEvent };
