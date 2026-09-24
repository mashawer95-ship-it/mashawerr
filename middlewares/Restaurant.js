const mongoose = require('mongoose');
const joi = require('joi');

// ─── Restaurant Schema ───────────────────────────────────────────────────────
const RestaurantSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            minlength: 2,
            maxlength: 200,
        },
        description: {
            type: String,
            trim: true,
            default: '',
            maxlength: 2000,
        },
        // Logo / main avatar stored as Cloudinary URL
        logo: {
            type: String,
            default: null,
        },
        // Optional cover image stored as Cloudinary URL
        coverImage: {
            type: String,
            default: null,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        // ─── Pickup Location (set by Admin) ─────────────────────────────────
        // Where the representative goes to pick up food / orders from this restaurant.
        pickupLocation: {
            lat:     { type: Number, default: null },
            lng:     { type: Number, default: null },
            address: { type: String, trim: true, default: '' },
        },
        // ─── Delivery Pricing (set by Admin) ────────────────────────────────
        deliveryPricePerMeter: {
            type: Number,
            default: null,
            min: 0,
            set: v => (v === '' || v === null || isNaN(v) ? null : Number(v)),
        },
        deliveryFlatFee: {
            type: Number,
            default: null,
            min: 0,
            set: v => (v === '' || v === null || isNaN(v) ? null : Number(v)),
        },
        // ─── Vehicle requirement for delivery (نوع المركبة المطلوبة للتوصيل) ─────
        requiredVehicleTypeId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'VehicleType',
            default: null,
            set: v => (v === '' || !v || !mongoose.Types.ObjectId.isValid(v) ? null : v),
        },
        requiredVehicleTypeName: {
            type: String,
            trim: true,
            default: null,
        },
        // ─── Agent / Agency linkage (الوكيل المسند إليه المطعم) ───────────────
        agentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
            set: v => (v === '' || !v || !mongoose.Types.ObjectId.isValid(v) ? null : v),
        },
        agentName: {
            type: String,
            trim: true,
            default: null,
        },
    },
    { timestamps: true }
);

const Restaurant = mongoose.model('Restaurant', RestaurantSchema);

// ─── Joi Validators ──────────────────────────────────────────────────────────

function validateCreateRestaurant(obj) {
    const schema = joi.object({
        name: joi.string().trim().min(2).max(200).required(),
        description: joi.string().trim().max(2000).allow('').default(''),
        isActive: joi.boolean().default(true),
        deliveryPricePerMeter: joi.number().min(0).allow('', null).default(null),
        deliveryFlatFee: joi.number().min(0).allow('', null).default(null),
        requiredVehicleTypeId: joi.string().trim().allow('', null).default(null),
        requiredVehicleTypeName: joi.string().trim().max(200).allow('', null).default(null),
        agentId: joi.string().trim().allow('', null).default(null),
        agentName: joi.string().trim().max(200).allow('', null).default(null),
        lat: joi.number().min(-90).max(90).allow('', null),
        lng: joi.number().min(-180).max(180).allow('', null),
        address: joi.string().trim().max(500).allow('', null),
        pickupLocation: joi.alternatives().try(
            joi.object({
                lat: joi.number().min(-90).max(90).allow(null),
                lng: joi.number().min(-180).max(180).allow(null),
                address: joi.string().trim().max(500).allow('', null).default(''),
            }),
            joi.string().allow('', null)
        ).optional().allow(null),
    });
    return schema.validate(obj, { abortEarly: false });
}

function validateUpdateRestaurant(obj) {
    const schema = joi
        .object({
            name: joi.string().trim().min(2).max(200),
            description: joi.string().trim().max(2000).allow(''),
            isActive: joi.boolean(),
            deliveryPricePerMeter: joi.number().min(0).allow('', null),
            deliveryFlatFee: joi.number().min(0).allow('', null),
            requiredVehicleTypeId: joi.string().trim().allow('', null),
            requiredVehicleTypeName: joi.string().trim().max(200).allow('', null),
            agentId: joi.string().trim().allow('', null),
            agentName: joi.string().trim().max(200).allow('', null),
            lat: joi.number().min(-90).max(90).allow('', null),
            lng: joi.number().min(-180).max(180).allow('', null),
            address: joi.string().trim().max(500).allow('', null),
            pickupLocation: joi.alternatives().try(
                joi.object({
                    lat: joi.number().min(-90).max(90).allow(null),
                    lng: joi.number().min(-180).max(180).allow(null),
                    address: joi.string().trim().max(500).allow('', null).default(''),
                }),
                joi.string().allow('', null)
            ).optional().allow(null),
        })
        .min(1)
        .messages({ 'object.min': 'Provide at least one field to update' });
    return schema.validate(obj, { abortEarly: false });
}

function validateSetRestaurantLocation(obj) {
    const schema = joi.object({
        lat:     joi.number().min(-90).max(90).required(),
        lng:     joi.number().min(-180).max(180).required(),
        address: joi.string().trim().max(500).allow('').default(''),
    });
    return schema.validate(obj, { abortEarly: false });
}

module.exports = {
    Restaurant,
    validateCreateRestaurant,
    validateUpdateRestaurant,
    validateSetRestaurantLocation,
};
