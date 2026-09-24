const mongoose = require('mongoose');
const joi = require('joi');

// ─── Cart Item Sub-Schema ─────────────────────────────────────────────────────
const CartItemSchema = new mongoose.Schema(
    {
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: true,
        },
        quantity: {
            type: Number,
            required: true,
            min: 1,
            default: 1,
        },
        priceAtAdd: {
            type: Number,
            required: true,
            min: 0,
        },
        selectedAddons: [
            {
                name: { type: String, required: true },
                price: { type: Number, default: 0 },
            }
        ],
        addonsTotal: {
            type: Number,
            default: 0,
        },
        // ─── Per-item delivery location (optional) ───────────────────────
        // Client can set a specific delivery destination for each product.
        // If not provided, the checkout-level deliveryLocation will be used.
        deliveryLocation: {
            lat:     { type: Number, default: null },
            lng:     { type: Number, default: null },
            address: { type: String, trim: true, default: '' },
        },
    },
    { _id: false }
);

// ─── Cart Schema ──────────────────────────────────────────────────────────────
const CartSchema = new mongoose.Schema(
    {
        userId: {
            type: String,
            required: true,
            unique: true, // one cart per user
            trim: true,
        },
        items: {
            type: [CartItemSchema],
            default: [],
        },
    },
    { timestamps: true }
);

/** Virtual: compute total on-the-fly */
CartSchema.virtual('total').get(function () {
    return this.items.reduce((sum, item) => sum + item.quantity * (item.priceAtAdd + (item.addonsTotal || 0)), 0);
});

CartSchema.set('toJSON', { virtuals: true });
CartSchema.set('toObject', { virtuals: true });

const Cart = mongoose.model('Cart', CartSchema);

// ─── Joi Validators ──────────────────────────────────────────────────────────

function validateAddToCart(obj) {
    const schema = joi.object({
        productId: joi.string().trim().length(24).pattern(/^[0-9a-fA-F]{24}$/).required()
            .messages({ 'string.pattern.base': 'productId must be a valid 24-char hex id' }),
        quantity: joi.number().integer().min(1).default(1),
        selectedAddons: joi.array().items(
            joi.object({
                _id: joi.string().optional().allow(null, ''),
                id: joi.string().optional().allow(null, ''),
                name: joi.string().trim().required(),
                price: joi.number().min(0).default(0),
                isRequired: joi.boolean().optional(),
            }).unknown(true)
        ).optional().default([]),
        deliveryLocation: joi.object({
            lat: joi.number().min(-90).max(90).required(),
            lng: joi.number().min(-180).max(180).required(),
            address: joi.string().trim().max(500).allow('').default(''),
        }).optional(),
    });
    return schema.validate(obj, { abortEarly: false });
}

function validateUpdateCartItem(obj) {
    const schema = joi.object({
        quantity: joi.number().integer().min(1).required(),
        deliveryLocation: joi.object({
            lat: joi.number().min(-90).max(90).required(),
            lng: joi.number().min(-180).max(180).required(),
            address: joi.string().trim().max(500).allow('').default(''),
        }).optional(),
    });
    return schema.validate(obj);
}

module.exports = {
    Cart,
    validateAddToCart,
    validateUpdateCartItem,
};
