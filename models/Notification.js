const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
    {
        userId: {
            type: String,
            required: [true, 'userId is required'],
            index: true,
        },
        title: {
            type: String,
            required: [true, 'title is required'],
            trim: true,
        },
        body: {
            type: String,
            required: [true, 'body is required'],
            trim: true,
        },
        data: {
            type: Object,
            default: {},
        },
        isRead: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model('Notification', notificationSchema);
