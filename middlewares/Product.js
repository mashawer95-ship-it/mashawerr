const mongoose = require('mongoose');
const joi = require('joi');

// ─── Product Schema ──────────────────────────────────────────────────────────
const ProductSchema = new mongoose.Schema(
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
        images: {
            type: [String],
            default: [], // Array of filenames, e.g. ['product-123.jpg', 'product-456.webp']
        },
        // Legacy field — old products stored a single image filename here.
        // Kept read-only so formatProduct() can migrate old data in responses.
        image: {
            type: String,
            default: null,
        },
        price: {
            type: Number,
            required: true,
            min: 0,
        },
        stock: {
            type: Number,
            required: true,
            min: 0,
            default: 0,
        },
        // Initial stock when product was first added — never changes after creation.
        // Used to calculate how much has been sold since launch.
        initialStock: {
            type: Number,
            default: 0,
            min: 0,
        },
        category: {
            type: String,
            trim: true,
            default: 'General',
            maxlength: 100,
        },
        isSoldOut: {
            type: Boolean,
            default: false,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        // ─── Agent ownership (one product → one agent) ───────────────────
        agentId: {
            type: String,   // MongoDB _id of the owning Agent user
            default: null,
            trim: true,
        },
        agentName: {
            type: String,   // Full name stored for fast display (no extra DB lookup)
            default: null,
            trim: true,
        },
        // ─── Sales & Popularity ──────────────────────────────────────────
        totalSold: {
            type: Number,
            default: 0,
            index: true,   // enables fast best-seller sort
        },
        // ─── User Ratings ────────────────────────────────────────────────
        averageRating: {
            type: Number,
            default: 0,
            min: 0,
            max: 5,
        },
        ratingCount: {
            type: Number,
            default: 0,
        },
        // ─── Association (جمعية) ─────────────────────────────────────────
        // The association this product belongs to. Null means no association.
        associationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Association',
            default: null,
        },
        // ─── Restaurant (مطعم) ───────────────────────────────────────────
        // The restaurant this product belongs to. Null means no restaurant.
        restaurantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Restaurant',
            default: null,
            index: true,
        },
        // ─── Add-ons / Options for Meals (إضافات الوجبة) ───────────────────
        addons: [
            {
                name: {
                    type: String,
                    required: true,
                    trim: true,
                    maxlength: 200,
                },
                price: {
                    type: Number,
                    required: true,
                    min: 0,
                    default: 0,
                },
                isRequired: {
                    type: Boolean,
                    default: false,
                },
            }
        ],
        // ─── Pickup Location (set by Agent) ──────────────────────────────
        // Where the driver should go to pick up this product.
        // Agent sets this via PATCH /api/store/products/:id/pickup-location
        pickupLocation: {
            lat:     { type: Number, default: null },
            lng:     { type: Number, default: null },
            address: { type: String, trim: true, default: '' },
        },
        // ─── Per-Product Delivery Pricing ────────────────────────────────
        deliveryPricePerMeter: {
            type: Number,
            default: null,
            min: 0,
        },
        deliveryFlatFee: {
            type: Number,
            default: null,
            min: 0,
        },
        // ─── Vehicle requirement for delivery (نوع المركبة المطلوبة للتوصيل) ─────
        requiredVehicleTypeId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'VehicleType',
            default: null,
        },
        requiredVehicleTypeName: {
            type: String,
            trim: true,
            default: null,
        },
    },
    { timestamps: true }
);

/** Auto-sync isSoldOut whenever stock changes */
ProductSchema.pre('save', function () {
    if (this.isModified('stock')) {
        this.isSoldOut = this.stock <= 0;
    }
});

const Product = mongoose.model('Product', ProductSchema);

// ─── Joi Validators ──────────────────────────────────────────────────────────

function validateCreateProduct(obj) {
    const schema = joi.object({
        name: joi.string().trim().min(2).max(200).required(),
        description: joi.string().trim().max(2000).allow('').default(''),
        price: joi.number().min(0).required(),
        stock: joi.number().integer().min(0).required(),
        category: joi.string().trim().max(100).allow('').default('General'),
        isActive: joi.boolean().default(true),
        agentId: joi.string().trim().allow('', null).default(null),
        agentName: joi.string().trim().max(200).allow('', null).default(null),
        associationId: joi.string().trim().allow('', null).default(null),
        restaurantId: joi.string().trim().allow('', null).default(null),
        deliveryPricePerMeter: joi.number().min(0).allow('', null).default(null),
        deliveryFlatFee: joi.number().min(0).allow('', null).default(null),
        requiredVehicleTypeId: joi.string().trim().allow('', null).default(null),
        requiredVehicleTypeName: joi.string().trim().max(200).allow('', null).default(null),
        lat: joi.number().min(-90).max(90).allow('', null),
        lng: joi.number().min(-180).max(180).allow('', null),
        address: joi.string().trim().max(500).allow('', null),
        addons: joi.array().items(
            joi.object({
                _id: joi.string().allow('', null).optional(),
                id: joi.string().allow('', null).optional(),
                name: joi.string().trim().min(1).max(200).required(),
                price: joi.number().min(0).default(0),
                isRequired: joi.boolean().default(false),
            })
        ).allow(null).default([]),
    });
    return schema.validate(obj, { abortEarly: false });
}

function validateUpdateProduct(obj) {
    const schema = joi.object({
        name: joi.string().trim().min(2).max(200),
        description: joi.string().trim().max(2000).allow(''),
        price: joi.number().min(0),
        stock: joi.number().integer().min(0),
        category: joi.string().trim().max(100).allow(''),
        isActive: joi.boolean(),
        agentId: joi.string().trim().allow('', null),
        agentName: joi.string().trim().max(200).allow('', null),
        associationId: joi.string().trim().allow('', null),
        restaurantId: joi.string().trim().allow('', null),
        deliveryPricePerMeter: joi.number().min(0).allow('', null),
        deliveryFlatFee: joi.number().min(0).allow('', null),
        requiredVehicleTypeId: joi.string().trim().allow('', null),
        requiredVehicleTypeName: joi.string().trim().max(200).allow('', null),
        lat: joi.number().min(-90).max(90).allow('', null),
        lng: joi.number().min(-180).max(180).allow('', null),
        address: joi.string().trim().max(500).allow('', null),
        replaceImages: joi.string().valid('true', 'false'),  // form-data string flag
        addons: joi.array().items(
            joi.object({
                _id: joi.string().allow('', null).optional(),
                id: joi.string().allow('', null).optional(),
                name: joi.string().trim().min(1).max(200).required(),
                price: joi.number().min(0).default(0),
                isRequired: joi.boolean().default(false),
            })
        ).allow(null),
    }).min(1).messages({ 'object.min': 'Provide at least one field to update' });
    return schema.validate(obj, { abortEarly: false });
}

function validateUpdateStock(obj) {
    const schema = joi.object({
        stock: joi.number().integer().min(0).required(),
    });
    return schema.validate(obj);
}

function validateAssignAgents(obj) {
    const schema = joi.object({
        agentIds: joi.array().items(joi.string().trim().required()).min(1).required(),
    });
    return schema.validate(obj);
}

module.exports = {
    Product,
    validateCreateProduct,
    validateUpdateProduct,
    validateUpdateStock,
    validateAssignAgents,
};
