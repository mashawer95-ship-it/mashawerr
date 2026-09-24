const mongoose = require('mongoose');
const joi = require('joi');

// ─── RepTarget Schema ─────────────────────────────────────────────────────────
// Stores the target config set by the admin.
// repId = null means it's a GLOBAL target for ALL representatives.
const RepTargetSchema = new mongoose.Schema(
    {
        // null = global target; ObjectId = individual representative target
        repId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            index: true,
        },
        period: {
            type: String,
            enum: ['daily', 'weekly', 'monthly', 'yearly'],
            required: true,
        },
        // Number of completed orders required to earn the reward
        targetCount: {
            type: Number,
            required: true,
            min: 1,
        },
        // Reward amount in Kuwaiti Fils (integer). e.g. 3000 = 3 KWD
        rewardFils: {
            type: Number,
            required: true,
            min: 0,
            default: 0,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        notes: {
            type: String,
            trim: true,
            default: '',
        },
        startDate: {
            type: Date,
            default: null,
        },
        endDate: {
            type: Date,
            default: null,
        },
        // Admin who created/last updated this target
        createdBy: {
            type: String,
            trim: true,
            default: null,
        },
    },
    { timestamps: true }
);

// Unique: one active target per (repId + period) combination
// repId can be null (global), so we use a sparse-aware compound index
RepTargetSchema.index({ repId: 1, period: 1, isActive: 1 });

const RepTarget = mongoose.model('RepTarget', RepTargetSchema);

// ─── RepTargetAchievement Schema ──────────────────────────────────────────────
// Tracks when a rep has already been rewarded for a target in a given period.
// Prevents double-rewarding via unique compound index.
const RepTargetAchievementSchema = new mongoose.Schema(
    {
        repId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        targetId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'RepTarget',
            required: true,
        },
        // The period type
        period: {
            type: String,
            enum: ['daily', 'weekly', 'monthly', 'yearly'],
            required: true,
        },
        // Human-readable period key to prevent duplicates.
        // Examples: "2026-08-12" (daily), "2026-W33" (weekly), "2026-08" (monthly), "2026" (yearly)
        periodKey: {
            type: String,
            required: true,
            trim: true,
        },
        achievedAt: {
            type: Date,
            default: Date.now,
        },
        // Snapshot of reward that was credited
        rewardFils: {
            type: Number,
            required: true,
        },
        // Reference to wallet transaction
        walletTxRef: {
            type: String,
            default: null,
        },
    },
    { timestamps: true }
);

// ── Unique constraint: one reward per (rep + target + period key) ──────────────
RepTargetAchievementSchema.index(
    { repId: 1, targetId: 1, periodKey: 1 },
    { unique: true }
);

const RepTargetAchievement = mongoose.model('RepTargetAchievement', RepTargetAchievementSchema);

// ─── Period Key Generator ─────────────────────────────────────────────────────
/**
 * Returns a string key representing the current period for the given period type.
 * Used as the de-duplication key in RepTargetAchievement.
 */
function getPeriodKey(period, date = new Date()) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

    if (period === 'daily') return `${year}-${month}-${day}`;
    if (period === 'monthly') return `${year}-${month}`;
    if (period === 'yearly') return `${year}`;
    if (period === 'weekly') {
        // ISO week number
        const startOfYear = new Date(year, 0, 1);
        const dayOfYear = Math.floor((d - startOfYear) / (24 * 60 * 60 * 1000));
        const weekNum = String(Math.ceil((dayOfYear + startOfYear.getDay() + 1) / 7)).padStart(2, '0');
        return `${year}-W${weekNum}`;
    }
    return `${year}-${month}-${day}`;
}

/**
 * Returns { start, end } Date range for a given period, centered on `date`.
 * If customStartDate and customEndDate are provided, returns that exact date-time range.
 */
function getPeriodRange(period, date = new Date(), customStartDate = null, customEndDate = null) {
    if (customStartDate && customEndDate) {
        const s = new Date(customStartDate);
        const e = new Date(customEndDate);
        if (!isNaN(s.getTime()) && !isNaN(e.getTime())) {
            return { start: s, end: e };
        }
    }
    const d = new Date(date);
    const year = d.getFullYear();
    const month = d.getMonth();
    const day = d.getDate();

    if (period === 'daily') {
        const start = new Date(year, month, day, 0, 0, 0, 0);
        const end = new Date(year, month, day, 23, 59, 59, 999);
        return { start, end };
    }
    if (period === 'weekly') {
        const dow = d.getDay(); // 0=Sunday
        const start = new Date(year, month, day - dow, 0, 0, 0, 0);
        const end = new Date(year, month, day - dow + 6, 23, 59, 59, 999);
        return { start, end };
    }
    if (period === 'monthly') {
        const start = new Date(year, month, 1, 0, 0, 0, 0);
        const end = new Date(year, month + 1, 0, 23, 59, 59, 999);
        return { start, end };
    }
    if (period === 'yearly') {
        const start = new Date(year, 0, 1, 0, 0, 0, 0);
        const end = new Date(year, 11, 31, 23, 59, 59, 999);
        return { start, end };
    }
    return { start: new Date(0), end: new Date() };
}

// ─── Joi Validators ──────────────────────────────────────────────────────────
function validateUpsertTarget(obj) {
    const schema = joi.object({
        targetId: joi.string().allow('', null).optional(),
        deactivateOthers: joi.boolean().optional(),
        period: joi.string().valid('daily', 'weekly', 'monthly', 'yearly').required()
            .messages({ 'any.only': 'period must be one of: daily, weekly, monthly, yearly' }),
        targetCount: joi.number().integer().min(1).required()
            .messages({ 'number.min': 'targetCount must be at least 1' }),
        rewardFils: joi.number().integer().min(0).required()
            .messages({ 'number.min': 'rewardFils cannot be negative' }),
        notes: joi.string().trim().max(500).allow('', null).optional().default(''),
        startDate: joi.date().iso().allow('', null).optional(),
        endDate: joi.date().iso().allow('', null).optional(),
    }).unknown(true);
    return schema.validate(obj, { abortEarly: false });
}

function validateUpsertGlobalTarget(obj) {
    const schema = joi.object({
        targetId: joi.string().allow('', null).optional(),
        deactivateOthers: joi.boolean().optional(),
        period: joi.string().valid('daily', 'weekly', 'monthly', 'yearly').required(),
        targetCount: joi.number().integer().min(1).required(),
        rewardFils: joi.number().integer().min(0).required(),
        notes: joi.string().trim().max(500).allow('', null).optional().default(''),
        startDate: joi.date().iso().allow('', null).optional(),
        endDate: joi.date().iso().allow('', null).optional(),
    }).unknown(true);
    return schema.validate(obj, { abortEarly: false });
}

module.exports = {
    RepTarget,
    RepTargetAchievement,
    getPeriodKey,
    getPeriodRange,
    validateUpsertTarget,
    validateUpsertGlobalTarget,
};
