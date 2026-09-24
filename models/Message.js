const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
    orderId: { type: String, required: true, index: true },
    senderId: { type: String, required: true },
    receiverId: { type: String, required: true },
    text: { type: String, default: '' },
    imageUrl: { type: String, default: null },
    audioUrl: { type: String, default: null },
    audioDuration: { type: Number, default: 0 },
    messageType: {
        type: String,
        enum: ['text', 'image', 'voice'],
        default: 'text'
    },
    senderName: { type: String, default: '' },
    status: {
        type: String,
        enum: ['sent', 'delivered', 'read'],
        default: 'sent'
    },
    readAt: { type: Date, default: null }
}, {
    timestamps: true // adds createdAt and updatedAt
});

module.exports = mongoose.model('Message', messageSchema);
