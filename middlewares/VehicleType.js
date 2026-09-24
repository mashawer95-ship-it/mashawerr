const mongoose = require('mongoose');
const joi = require('joi');

const VehicleTypeSchema = new mongoose.Schema(
    {
        name_ar: {
            type: String,
            required: true,
        },
        name_en: {
            type: String,
        },
        image: {
            type: String,
        },
        icon_key: {
            type: String,
            default: 'sedan',
        },
        baseFare: {
            type: Number,
            required: true,
            min: 0,
            default: 0,
        },
        pricePerMeter: {
            type: Number,
            required: true,
            min: 0,
            default: 0,
        },
        minFare: {
            type: Number,
            required: true,
            min: 0,
            default: 0,
        },
        surgeMultiplier: {
            type: Number,
            required: true,
            min: 0,
            default: 1,
        },
        category: {
            type: String,
            enum: ['delivery', 'business', 'both'],
            default: 'both',
        },
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { versionKey: false, timestamps: true }
);

const VehicleType = mongoose.model('VehicleType', VehicleTypeSchema);

const filsField = (name) =>
    joi.number().min(0).max(1e12).messages({
        'number.base': `${name} must be a number (fils, decimals allowed)`,
        'number.min': `${name} cannot be negative`,
        'number.max': `${name} is too large`,
    });

function validateCreateVehicleType(object) {
    const schema = joi.object({
        name_ar: joi.string().trim().required().messages({
            'string.base': 'name_ar must be a string',
            'any.required': 'name_ar is required',
        }),
        name_en: joi.string().trim().allow(null, '').optional(),
        image: joi.string().allow(null, '').optional(),
        icon_key: joi.string().trim().allow(null, '').optional(),
        iconKey: joi.string().trim().allow(null, '').optional(),
        baseFare: filsField('baseFare').optional(),
        pricePerMeter: filsField('pricePerMeter').optional(),
        minFare: filsField('minFare').optional(),
        surgeMultiplier: joi.number().min(0).optional(),
        category: joi.string().valid('delivery', 'business', 'both').optional().default('both'),
        isActive: joi.boolean().optional(),
    });
    return schema.validate(object, { allowUnknown: true });
}

function validateUpdateVehicleType(object) {
    const schema = joi.object({
        name_ar: joi.string().trim().optional(),
        name_en: joi.string().trim().allow(null, '').optional(),
        image: joi.string().allow(null, '').optional(),
        icon_key: joi.string().trim().allow(null, '').optional(),
        iconKey: joi.string().trim().allow(null, '').optional(),
        baseFare: filsField('baseFare').optional(),
        pricePerMeter: filsField('pricePerMeter').optional(),
        minFare: filsField('minFare').optional(),
        surgeMultiplier: joi.number().min(0).optional(),
        category: joi.string().valid('delivery', 'business', 'both').optional(),
        isActive: joi.boolean().optional(),
    }).min(1);
    return schema.validate(object, { allowUnknown: true });
}

function validateCalculatePrice(object) {
    const schema = joi.object({
        locations: joi.array().items(
            joi.object({
                lat: joi.number().required(),
                lng: joi.number().required(),
            })
        ).min(2).optional().messages({
            'array.base': 'locations must be an array of coordinates',
            'array.min': 'at least 2 locations (origin and destination) are required',
        }),
        tasks: joi.array().items(
            joi.object({
                fromLatitude: joi.number().required(),
                fromLongitude: joi.number().required(),
                toLatitude: joi.number().required(),
                toLongitude: joi.number().required(),
            }).unknown(true)
        ).min(1).optional()
    }).or('locations', 'tasks').messages({
        'object.missing': 'You must provide either locations or tasks'
    });
    return schema.validate(object);
}

module.exports = {
    VehicleType,
    validateCreateVehicleType,
    validateUpdateVehicleType,
    validateCalculatePrice,
};
