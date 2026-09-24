const mongoose = require('mongoose');

const fcmTokenSchema = new mongoose.Schema(
    {
        userId: {
            type: String,
            required: [true, 'userId is required'],
            unique: true,
            trim: true,
        },
        fcmToken: {
            type: String,
            required: [true, 'fcmToken is required'],
            trim: true,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model('FcmToken', fcmTokenSchema);
