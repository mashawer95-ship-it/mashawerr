/**
 * Trip.js
 * Mongoose schema and model for Trip documents in MongoDB.
 */

const mongoose = require('mongoose');

const TripSchema = new mongoose.Schema({
    _id: { type: String, required: true }, // tripId / orderId
    driverId: { type: String },
    status: {
        type: String,
        enum: ['pending', 'active', 'completed', 'cancelled'],
        default: 'pending',
    },
    encodedPolyline: { type: String, default: '' },
    distanceMeters: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: 0 },
    routeToken: { type: String, default: null },
    legs: { type: Array, default: [] },
    origin: {
        lat: { type: Number },
        lng: { type: Number },
    },
    destination: {
        lat: { type: Number },
        lng: { type: Number },
    },
    routeVersion: { type: Number, default: 1 },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
    lastRerouteAt: { type: Date },
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
});

// Virtual tripId mapping
TripSchema.virtual('tripId').get(function () {
    return this._id;
});

const Trip = mongoose.models.Trip || mongoose.model('Trip', TripSchema);

module.exports = { Trip };
