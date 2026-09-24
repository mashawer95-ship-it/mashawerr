const mongoose = require('mongoose');
const joi = require('joi');

// ─── UserRating Schema ────────────────────────────────────────────────────────
// بعد اكتمال الأوردر: العميل يقيّم المندوب والمندوب يقيّم العميل
const UserRatingSchema = new mongoose.Schema(
    {
        orderId: {
            type: mongoose.Schema.Types.Mixed,
            required: true,
        },
        // من يعطي التقييم
        raterId: {
            type: String,
            required: true,
            trim: true,
        },
        raterType: {
            type: String,
            enum: ['client', 'representative'],
            required: true,
        },
        // من يتلقى التقييم
        rateeId: {
            type: String,
            required: true,
            trim: true,
        },
        rateeType: {
            type: String,
            enum: ['client', 'representative'],
            required: true,
        },
        rating: {
            type: Number,
            required: true,
            min: 1,
            max: 5,
        },
        comment: {
            type: String,
            trim: true,
            maxlength: 1000,
            default: '',
        },
        reasons: [
            {
                type: String,
                trim: true,
            },
        ],
    },
    { timestamps: true }
);

// تقييم واحد لكل رايتر/رايتي/أوردر
UserRatingSchema.index({ orderId: 1, raterId: 1, rateeId: 1 }, { unique: true });
// فهرس سريع لجلب كل تقييمات مستخدم معين
UserRatingSchema.index({ rateeId: 1, createdAt: -1 });
// فهرس لجلب تقييمات أوردر معين
UserRatingSchema.index({ orderId: 1 });

const UserRating = mongoose.model('UserRating', UserRatingSchema);

// ─── Joi Validators ───────────────────────────────────────────────────────────

/**
 * Validate the body for submitting a user rating.
 * raterId, raterType, rateeId, rateeType come from route logic / auth.
 */
function validateUserRating(obj) {
    const schema = joi.object({
        raterId: joi.string().trim().optional().allow('', null),
        raterType: joi.string().valid('client', 'representative').required().messages({
            'any.required': 'raterType is required (client | representative)',
            'any.only': 'raterType must be either "client" or "representative"',
        }),
        rateeId: joi.string().trim().required().messages({
            'any.required': 'rateeId is required',
        }),
        rateeType: joi.string().valid('client', 'representative').required().messages({
            'any.required': 'rateeType is required (client | representative)',
            'any.only': 'rateeType must be either "client" or "representative"',
        }),
        rating: joi.number().integer().min(1).max(5).required().messages({
            'any.required': 'rating is required (1–5)',
            'number.min': 'rating must be at least 1',
            'number.max': 'rating must be at most 5',
        }),
        comment: joi.string().trim().max(1000).allow('').default(''),
        reasons: joi.array().items(joi.string().trim()).default([]),
    });
    return schema.validate(obj, { abortEarly: false });
}

module.exports = { UserRating, validateUserRating };
