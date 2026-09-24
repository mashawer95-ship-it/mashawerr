const mongoose = require('mongoose');

const SessionLogSchema = new mongoose.Schema({
    openAt: { type: Date, required: true },
    closeAt: { type: Date, default: null },
    durationMinutes: { type: Number, default: 0 },
}, { _id: true });

const LocationSchema = new mongoose.Schema({
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    accuracy: { type: Number, default: null },
    address: { type: String, default: null },
}, { _id: false });

const DeviceInfoSchema = new mongoose.Schema({
    platform: { type: String, default: null },
    osVersion: { type: String, default: null },
    appVersion: { type: String, default: null },
    deviceId: { type: String, default: null },
    deviceModel: { type: String, default: null },
    batteryLevel: { type: Number, default: null },
    ip: { type: String, default: null },
}, { _id: false });

const AttendanceRecordSchema = new mongoose.Schema({
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
    date: {
        type: Date,
        required: true,
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

    // ─── Manual Check-in / Out ──────────
    manualCheckInAt: { type: Date, default: null },
    manualCheckInLocation: { type: LocationSchema, default: () => ({}) },
    manualCheckOutAt: { type: Date, default: null },
    manualCheckOutLocation: { type: LocationSchema, default: () => ({}) },
    manualCheckInDevice: { type: DeviceInfoSchema, default: () => ({}) },
    isManualCheckIn: { type: Boolean, default: false, index: true },

    // ─── Automatic Background Tracking ──
    appOpenAt: { type: Date, default: null },
    appCloseAt: { type: Date, default: null },
    totalOnlineMinutes: { type: Number, default: 0 },
    sessionLogs: [SessionLogSchema],

    // ─── Summary ─────────────────────────
    status: {
        type: String,
        enum: ['present', 'absent', 'late', 'partial', 'manual_only', 'pending'],
        default: 'absent',
        index: true,
    },
    ordersDelivered: { type: Number, default: 0 },
    notes: { type: String, default: '' },
}, {
    timestamps: true,
});

// Ensure a single representative has at most 1 attendance record per date
AttendanceRecordSchema.index({ representativeId: 1, dateStr: 1 }, { unique: true });
AttendanceRecordSchema.index({ year: 1, month: 1 });
AttendanceRecordSchema.index({ year: 1, week: 1 });

const AttendanceRecord = mongoose.model('AttendanceRecord', AttendanceRecordSchema);

module.exports = AttendanceRecord;
