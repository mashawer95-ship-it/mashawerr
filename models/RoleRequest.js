const mongoose = require('mongoose');

const RoleRequestSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    requestedRole: {
        type: String,
        enum: ['Representative'],
        required: true,
    },
    description: {
        type: String,
        required: true,
        trim: true,
        maxlength: 1000,
    },
    phone: {
        type: String,
        required: true,
        trim: true,
        minlength: 7,
        maxlength: 15,
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
    },
}, { timestamps: true });

const RoleRequest = mongoose.model('RoleRequest', RoleRequestSchema);

module.exports = {
    RoleRequest,
};
