const mongoose = require('mongoose');

const FeedbackSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    userType: {
        type: String,
        trim: true,
        default: 'NormalUser',
    },
    userName: {
        type: String,
        trim: true,
        default: '',
    },
    userPhone: {
        type: String,
        trim: true,
        default: '',
    },
    userEmail: {
        type: String,
        trim: true,
        default: '',
    },
    description: {
        type: String,
        required: [true, 'الوصف مطلوب'],
        trim: true,
        minlength: 2,
        maxlength: 3000,
    },
    status: {
        type: String,
        enum: ['pending', 'in_progress', 'resolved'],
        default: 'pending',
    },
    adminNotes: {
        type: String,
        default: '',
    },
}, {
    timestamps: true,
});

FeedbackSchema.index({ createdAt: -1 });
FeedbackSchema.index({ userId: 1 });
FeedbackSchema.index({ userType: 1 });
FeedbackSchema.index({ status: 1 });

const Feedback = mongoose.model('Feedback', FeedbackSchema);

module.exports = { Feedback };
