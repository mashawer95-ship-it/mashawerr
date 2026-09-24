const mongoose = require('mongoose');

const ShiftSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Shift name is required'],
        trim: true,
        minlength: 2,
        maxlength: 50,
    },
    startTime: {
        type: String,
        required: [true, 'Shift start time is required (HH:mm)'],
        match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'startTime must be in HH:mm 24-hour format'],
    },
    endTime: {
        type: String,
        required: [true, 'Shift end time is required (HH:mm)'],
        match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'endTime must be in HH:mm 24-hour format'],
    },
    durationHours: {
        type: Number,
        default: 8,
        min: 0.01,
        max: 24,
    },
    crossesMidnight: {
        type: Boolean,
        default: false,
    },
    days: {
        type: [String],
        enum: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        default: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    },
    isActive: {
        type: Boolean,
        default: true,
        index: true,
    },
    representativeIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        index: true,
    }],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
}, {
    timestamps: true,
});

const DAY_MAP = {
    'Saturday': 'Sat',
    'Sunday': 'Sun',
    'Monday': 'Mon',
    'Tuesday': 'Tue',
    'Wednesday': 'Wed',
    'Thursday': 'Thu',
    'Friday': 'Fri',
    'Sat': 'Sat',
    'Sun': 'Sun',
    'Mon': 'Mon',
    'Tue': 'Tue',
    'Wed': 'Wed',
    'Thu': 'Thu',
    'Fri': 'Fri',
};

ShiftSchema.pre('validate', function (next) {
    if (this.days && Array.isArray(this.days)) {
        this.days = this.days.map(d => DAY_MAP[d] || d);
    }
    if (typeof next === 'function') next();
});

// Pre-save hook: auto calculate durationHours and crossesMidnight if not manually overridden
ShiftSchema.pre('save', function (next) {
    if (this.isModified('startTime') || this.isModified('endTime')) {
        const [startH, startM] = this.startTime.split(':').map(Number);
        const [endH, endM] = this.endTime.split(':').map(Number);

        const startTotalMinutes = startH * 60 + startM;
        const endTotalMinutes = endH * 60 + endM;

        if (endTotalMinutes < startTotalMinutes || (endTotalMinutes === startTotalMinutes && startTotalMinutes !== 0)) {
            this.crossesMidnight = true;
            const diffMinutes = (24 * 60 - startTotalMinutes) + endTotalMinutes;
            this.durationHours = Math.round((diffMinutes / 60) * 100) / 100;
        } else {
            this.crossesMidnight = false;
            const diffMinutes = endTotalMinutes - startTotalMinutes;
            this.durationHours = diffMinutes === 0 ? 24 : Math.round((diffMinutes / 60) * 100) / 100;
        }
    }
    if (typeof next === 'function') next();
});

const Shift = mongoose.model('Shift', ShiftSchema);

module.exports = Shift;
