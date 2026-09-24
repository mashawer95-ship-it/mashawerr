const mongoose = require('mongoose');
const joi = require('joi');

// ─── DiscountCode Schema ───────────────────────────────────────────────────────
// General discount codes that any user can apply. Admin creates them.

const DiscountCodeSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: true,
            unique: true,
            uppercase: true,
            trim: true,
        },
        description: { type: String, trim: true, default: '' },
        type: {
            type: String,
            enum: ['percentage', 'fixed'],
            required: true,
        },
        // percentage: 0-100 (e.g. 20 = 20% off)
        // fixed: amount in fils (e.g. 500 = 500 fils = 0.5 KD off)
        value: { type: Number, required: true, min: 0 },
        isActive: { type: Boolean, default: true },
        isPermanent: { type: Boolean, default: false },
        expiresAt: { type: Date, default: null },
        usageLimit: { type: Number, default: null }, // null = unlimited (إجمالي الاستخدامات لكل المستخدمين)
        usedCount: { type: Number, default: 0, min: 0 },
        /** كل userId استخدم الكود مرة واحدة فقط — لا يُعاد استخدامه لنفس المستخدم */
        usedByUserIds: { type: [String], default: [] },
    },
    { timestamps: true }
);

const DiscountCode = mongoose.model('DiscountCode', DiscountCodeSchema);

// ─── UserDiscount Schema ──────────────────────────────────────────────────────
// Discount assigned by admin directly to a specific user.
// Each user can have at most one active personal discount.

const UserDiscountSchema = new mongoose.Schema(
    {
        userId: { type: String, required: true, unique: true, trim: true },
        discountPercentage: { type: Number, required: true, min: 0, max: 100 },
        isPermanent: { type: Boolean, default: false },
        expiresAt: { type: Date, default: null },
        isActive: { type: Boolean, default: true },
        assignedBy: { type: String, trim: true, default: '' }, // admin's user id
        note: { type: String, trim: true, default: '' },
    },
    { timestamps: true }
);

const UserDiscount = mongoose.model('UserDiscount', UserDiscountSchema);

// ─── GlobalDiscount Schema (Singleton) ────────────────────────────────────────
// A single document that defines a general discount for all normal users.

const GlobalDiscountSchema = new mongoose.Schema(
    {
        discountPercentage: { type: Number, required: true, min: 0, max: 100, default: 0 },
        isActive: { type: Boolean, default: false },
        expiresAt: { type: Date, default: null }, // If null and isActive=true, it's permanent
        isOneTimeOnly: { type: Boolean, default: false }, // If true, each user can use this discount only once
        usedByUserIds: [{ type: String, trim: true }], // User IDs that used the discount when isOneTimeOnly is true
    },
    { timestamps: true }
);

const GlobalDiscount = mongoose.model('GlobalDiscount', GlobalDiscountSchema);

async function getOrCreateGlobalDiscount() {
    let globalDiscount = await GlobalDiscount.findOne();
    if (!globalDiscount) {
        globalDiscount = await GlobalDiscount.create({});
    }
    return globalDiscount;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isDiscountExpired(discount) {
    if (discount.isPermanent) return false;
    if (!discount.expiresAt) return true;
    return new Date() > new Date(discount.expiresAt);
}

function isDiscountValid(discount) {
    if (!discount.isActive) return false;
    if (isDiscountExpired(discount)) return false;
    return true;
}

/**
 * Calculate discount amount (in fils) and final price.
 * @param {number} deliveryPrice - original delivery price in fils
 * @param {'percentage'|'fixed'} type
 * @param {number} value - percentage (0-100) or fils amount
 */
function calculateDiscount(deliveryPrice, type, value) {
    let discountAmount = 0;
    if (type === 'percentage') {
        discountAmount = Math.round((deliveryPrice * value) / 100);
    } else {
        discountAmount = Math.min(value, deliveryPrice);
    }
    const finalPrice = Math.max(0, deliveryPrice - discountAmount);
    return { discountAmount, finalPrice };
}

/**
 * تحقق: هل يمكن لهذا المستخدم استخدام كود الخصم؟ (مرة واحدة لكل userId)
 */
async function assertUserCanUseDiscountCode(userId, codeRaw) {
    const uid = String(userId || '').trim();
    const code = String(codeRaw || '').trim().toUpperCase();
    if (!uid || !code) {
        return { ok: false, status: 400, message: 'userId and discount code are required' };
    }
    const discount = await DiscountCode.findOne({ code });
    if (!discount) {
        return { ok: false, status: 404, message: 'Discount code not found' };
    }
    if (!discount.isActive) {
        return { ok: false, status: 400, message: 'Discount code is inactive' };
    }
    if (!isDiscountValid(discount)) {
        return { ok: false, status: 400, message: 'Discount code has expired' };
    }
    const usedBy = discount.usedByUserIds || [];
    if (usedBy.includes(uid)) {
        return { ok: false, status: 400, message: 'This user has already used this discount code' };
    }
    if (discount.usageLimit !== null && discount.usedCount >= discount.usageLimit) {
        return { ok: false, status: 400, message: 'Discount code has reached its usage limit' };
    }
    return { ok: true, discount };
}

/**
 * تحقق: هل يمكن لهذا المستخدم الاستفادة من الخصم العام؟
 * في حال كان الخصم العام لمرة واحدة فقط (isOneTimeOnly = true)، نتحقق من عدم استخدامه مسبقاً.
 */
async function assertUserCanUseGlobalDiscount(userId) {
    const uid = String(userId || '').trim();
    const globalDiscount = await getOrCreateGlobalDiscount();
    if (!globalDiscount.isActive) {
        return { ok: false, status: 400, message: 'Global discount is not active' };
    }
    if (globalDiscount.expiresAt && new Date() > new Date(globalDiscount.expiresAt)) {
        return { ok: false, status: 400, message: 'Global discount has expired' };
    }
    if (globalDiscount.isOneTimeOnly) {
        if (!uid) {
            return { ok: false, status: 400, message: 'User ID is required for one-time global discount' };
        }
        if (globalDiscount.usedByUserIds && globalDiscount.usedByUserIds.includes(uid)) {
            return { ok: false, status: 400, message: 'لقد استخدمت هذا الخصم العام بالفعل (متاح للاستخدام لمرة واحدة فقط لكل عميل)' };
        }
    }
    return { ok: true, globalDiscount };
}

/**
 * بعد حفظ أوردر ناجح استُخدم فيه خصم:
 * - `user_discount` → حذف الخصم الشخصي للمستخدم (مرة واحدة).
 * - `percentage` / `fixed` + `discountCode` → تسجيل userId في `usedByUserIds` + زيادة `usedCount` (الكود يظل نشطاً لباقي المستخدمين).
 * يُستدعى فقط عندما discountAmount > 0.
 */
async function consumeDiscountAfterSuccessfulOrder({ clientId, discountCode, discountType, discountAmount }) {
    const amt = Number(discountAmount) || 0;
    if (amt <= 0) return;

    const type = discountType ? String(discountType).trim() : '';

    if (type === 'user_discount') {
        await UserDiscount.deleteOne({ userId: String(clientId).trim() });
        return;
    }

    if ((type === 'percentage' || type === 'fixed') && discountCode) {
        const code = String(discountCode).trim().toUpperCase();
        const uid = String(clientId).trim();
        await DiscountCode.findOneAndUpdate(
            { code, isActive: true, usedByUserIds: { $nin: [uid] } },
            { $addToSet: { usedByUserIds: uid }, $inc: { usedCount: 1 } },
            { new: false }
        );
        return;
    }

    if (type === 'global_discount') {
        const globalDiscount = await getOrCreateGlobalDiscount();
        if (globalDiscount && globalDiscount.isOneTimeOnly) {
            const uid = String(clientId).trim();
            if (uid) {
                await GlobalDiscount.updateOne(
                    { _id: globalDiscount._id, usedByUserIds: { $ne: uid } },
                    { $addToSet: { usedByUserIds: uid } }
                );
            }
        }
        return;
    }
}

// ─── Joi Validators ───────────────────────────────────────────────────────────

function validateCreateDiscountCode(obj) {
    const schema = joi.object({
        code: joi.string().trim().min(2).max(50).required().messages({
            'any.required': 'code is required',
            'string.min': 'code must be at least 2 characters',
            'string.max': 'code cannot exceed 50 characters',
        }),
        description: joi.string().trim().allow('').max(500).default(''),
        type: joi.string().valid('percentage', 'fixed').required().messages({
            'any.required': 'type is required (percentage or fixed)',
            'any.only': 'type must be percentage or fixed',
        }),
        value: joi.number().min(0).required().messages({
            'any.required': 'value is required',
            'number.min': 'value cannot be negative',
        }),
        isActive: joi.boolean().default(true),
        isPermanent: joi.boolean().default(false),
        expiresAt: joi.date().allow(null).default(null),
        usageLimit: joi.number().integer().min(1).allow(null).default(null),
    });
    return schema.validate(obj, { abortEarly: false });
}

function validateUpdateDiscountCode(obj) {
    const schema = joi
        .object({
            description: joi.string().trim().allow('').max(500),
            type: joi.string().valid('percentage', 'fixed'),
            value: joi.number().min(0),
            isActive: joi.boolean(),
            isPermanent: joi.boolean(),
            expiresAt: joi.date().allow(null),
            usageLimit: joi.number().integer().min(1).allow(null),
        })
        .min(1)
        .messages({ 'object.min': 'Send at least one field to update' });
    return schema.validate(obj, { abortEarly: false });
}

function validateApplyCode(obj) {
    const schema = joi.object({
        userId: joi.string().trim().required().messages({
            'any.required': 'userId is required',
            'string.empty': 'userId cannot be empty',
        }),
        code: joi.string().trim().required().messages({ 'any.required': 'code is required' }),
        deliveryPrice: joi.number().min(0).required().messages({
            'any.required': 'deliveryPrice is required',
            'number.min': 'deliveryPrice cannot be negative',
        }),
    });
    return schema.validate(obj);
}

function validateApplyMyDiscount(obj) {
    const schema = joi.object({
        userId: joi.string().trim().required().messages({
            'any.required': 'userId is required',
            'string.empty': 'userId cannot be empty',
        }),
        deliveryPrice: joi.number().min(0).required().messages({
            'any.required': 'deliveryPrice is required',
            'number.min': 'deliveryPrice cannot be negative',
        }),
    });
    return schema.validate(obj);
}

function validateAssignUserDiscount(obj) {
    const schema = joi.object({
        userId: joi.string().trim().required().messages({ 'any.required': 'userId is required' }),
        discountPercentage: joi
            .number()
            .min(0)
            .max(100)
            .required()
            .messages({
                'any.required': 'discountPercentage is required',
                'number.min': 'discountPercentage cannot be negative',
                'number.max': 'discountPercentage cannot exceed 100',
            }),
        isPermanent: joi.boolean().default(false),
        expiresAt: joi.date().allow(null).default(null),
        note: joi.string().trim().allow('').max(500).default(''),
    });
    return schema.validate(obj, { abortEarly: false });
}

function validateUpdateUserDiscount(obj) {
    const schema = joi
        .object({
            discountPercentage: joi.number().min(0).max(100),
            isPermanent: joi.boolean(),
            expiresAt: joi.date().allow(null),
            isActive: joi.boolean(),
            note: joi.string().trim().allow('').max(500),
        })
        .min(1)
        .messages({ 'object.min': 'Send at least one field to update' });
    return schema.validate(obj, { abortEarly: false });
}

function validateUpdateGlobalDiscount(obj) {
    const schema = joi.object({
        discountPercentage: joi.number().min(0).max(100),
        isActive: joi.boolean(),
        expiresAt: joi.date().allow(null),
        isOneTimeOnly: joi.boolean(),
        resetUsedUsers: joi.boolean(),
    }).min(1);
    return schema.validate(obj);
}

module.exports = {
    DiscountCode,
    UserDiscount,
    isDiscountValid,
    isDiscountExpired,
    calculateDiscount,
    assertUserCanUseDiscountCode,
    assertUserCanUseGlobalDiscount,
    consumeDiscountAfterSuccessfulOrder,
    validateCreateDiscountCode,
    validateUpdateDiscountCode,
    validateApplyCode,
    validateApplyMyDiscount,
    validateAssignUserDiscount,
    validateUpdateUserDiscount,
    GlobalDiscount,
    getOrCreateGlobalDiscount,
    validateUpdateGlobalDiscount,
};
