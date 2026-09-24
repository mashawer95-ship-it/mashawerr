const mongoose = require('mongoose');
const joi = require('joi');

// ─── Association Schema ──────────────────────────────────────────────────────
const AssociationSchema = new mongoose.Schema(
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
        // Logo / cover image stored as Cloudinary URL
        logo: {
            type: String,
            default: null,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        // ─── Pickup Location (set by Admin) ─────────────────────────────────
        // Where the representative goes to pick up products of this association.
        // Admin sets this via PATCH /api/store/associations/:id/location
        pickupLocation: {
            lat:     { type: Number, default: null },
            lng:     { type: Number, default: null },
            address: { type: String, trim: true, default: '' },
        },
    },
    { timestamps: true }
);

const Association = mongoose.model('Association', AssociationSchema);

// ─── Joi Validators ──────────────────────────────────────────────────────────

function validateCreateAssociation(obj) {
    const schema = joi.object({
        name: joi.string().trim().min(2).max(200).required(),
        description: joi.string().trim().max(2000).allow('').default(''),
        isActive: joi.boolean().default(true),
    });
    return schema.validate(obj, { abortEarly: false });
}

function validateUpdateAssociation(obj) {
    const schema = joi
        .object({
            name: joi.string().trim().min(2).max(200),
            description: joi.string().trim().max(2000).allow(''),
            isActive: joi.boolean(),
        })
        .min(1)
        .messages({ 'object.min': 'Provide at least one field to update' });
    return schema.validate(obj, { abortEarly: false });
}

function validateSetAssociationLocation(obj) {
    const schema = joi.object({
        lat:     joi.number().min(-90).max(90).required(),
        lng:     joi.number().min(-180).max(180).required(),
        address: joi.string().trim().max(500).allow('').default(''),
    });
    return schema.validate(obj, { abortEarly: false });
}

module.exports = {
    Association,
    validateCreateAssociation,
    validateUpdateAssociation,
    validateSetAssociationLocation,
};
