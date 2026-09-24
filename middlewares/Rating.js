const mongoose = require('mongoose');
const joi = require('joi');

// ─── Rating Schema ────────────────────────────────────────────────────────────
const RatingSchema = new mongoose.Schema(
    {
        userId: {
            type: String,
            required: true,
            trim: true,
        },
        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
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
    },
    { timestamps: true }
);

// One rating per user per product
RatingSchema.index({ userId: 1, productId: 1 }, { unique: true });
// Index for fast lookup of all ratings for a product
RatingSchema.index({ productId: 1, createdAt: -1 });

const Rating = mongoose.model('Rating', RatingSchema);

// ─── Joi Validator ────────────────────────────────────────────────────────────
function validateRating(obj) {
    const schema = joi.object({
        rating: joi.number().integer().min(1).max(5).required(),
        comment: joi.string().trim().max(1000).allow('').default(''),
    });
    return schema.validate(obj);
}

module.exports = { Rating, validateRating };
