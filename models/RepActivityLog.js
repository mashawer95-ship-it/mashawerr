const mongoose = require('mongoose');

const RepActivityLogSchema = new mongoose.Schema({
    representativeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    shiftId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Shift',
        default: null,
        index: true,
    },
    dateStr: {
        type: String, // YYYY-MM-DD
        required: true,
        index: true,
    },
    week: {
        type: Number,
        required: true,
        index: true,
    },
    month: {
        type: Number,
        required: true,
        index: true,
    },
    year: {
        type: Number,
        required: true,
        index: true,
    },
    eventType: {
        type: String,
        enum: [
            'app_open',
            'app_close',
            'manual_check_in',
            'manual_check_out',
            'order_accepted',
            'order_delivered',
            'went_online',
            'went_offline',
            'heartbeat',
        ],
        required: true,
        index: true,
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true,
    },
    orderId: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
    },
    orderStatus: {
        type: String,
        default: null,
    },
    location: {
        lat: { type: Number, default: null },
        lng: { type: Number, default: null },
        accuracy: { type: Number, default: null },
        address: { type: String, default: null },
    },
    metadata: {
        type: Object,
        default: {},
    },
}, {
    timestamps: true,
});

// Indexes for ultra-fast query performance across millions of rows
RepActivityLogSchema.index({ representativeId: 1, timestamp: -1 });
RepActivityLogSchema.index({ representativeId: 1, dateStr: 1 });
RepActivityLogSchema.index({ year: 1, month: 1 });
RepActivityLogSchema.index({ year: 1, week: 1 });

const RepActivityLog = mongoose.model('RepActivityLog', RepActivityLogSchema);

module.exports = RepActivityLog;
