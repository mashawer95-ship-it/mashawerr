const asyncHandler = require('express-async-handler');
const {
    DiscountCode,
    UserDiscount,
    assertUserCanUseDiscountCode,
    calculateDiscount,
    isDiscountValid,
    validateCreateDiscountCode,
    validateUpdateDiscountCode,
    validateApplyCode,
    validateApplyMyDiscount,
    validateAssignUserDiscount,
    validateUpdateUserDiscount,
    getOrCreateGlobalDiscount,
    validateUpdateGlobalDiscount,
    isDiscountExpired,
} = require('../middlewares/Discount');

// ─── User Endpoints ───────────────────────────────────────────────────────────

/**
 * @desc  Apply a discount code to a delivery price
 * @route POST /api/discounts/apply-code
 * @access Public
 */
const applyDiscountCode = asyncHandler(async (req, res) => {
    const { error, value } = validateApplyCode(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { userId, code, deliveryPrice } = value;

    const check = await assertUserCanUseDiscountCode(userId, code);
    if (!check.ok) {
        return res.status(check.status).json({ message: check.message });
    }
    const discount = check.discount;

    const { discountAmount, finalPrice } = calculateDiscount(deliveryPrice, discount.type, discount.value);

    return res.status(200).json({
        originalPrice: deliveryPrice,
        discountCode: discount.code,
        discountType: discount.type,
        discountValue: discount.value,
        discountAmount,
        finalPrice,
        description: discount.description || '',
        isPermanent: discount.isPermanent,
        expiresAt: discount.expiresAt || null,
    });
});

/**
 * @desc  Get a user's personal discount info (assigned by admin)
 * @route GET /api/discounts/my-discount?userId=
 * @access Public
 */
const getMyDiscount = asyncHandler(async (req, res) => {
    const userId = (req.query.userId || '').trim();
    if (!userId) {
        return res.status(400).json({ message: 'userId query parameter is required' });
    }

    const userDiscount = await UserDiscount.findOne({ userId });

    if (!userDiscount) {
        return res.status(404).json({ message: 'No discount assigned to this account' });
    }

    const valid = isDiscountValid(userDiscount);

    return res.status(200).json({
        userId: userDiscount.userId,
        discountPercentage: userDiscount.discountPercentage,
        isPermanent: userDiscount.isPermanent,
        expiresAt: userDiscount.expiresAt || null,
        isActive: userDiscount.isActive,
        isExpired: !valid,
        note: userDiscount.note || '',
        createdAt: userDiscount.createdAt,
        updatedAt: userDiscount.updatedAt,
    });
});

/**
 * @desc  Apply a user's personal discount to a delivery price
 * @route POST /api/discounts/my-discount/apply
 * @access Public
 */
const applyMyDiscount = asyncHandler(async (req, res) => {
    const { error, value } = validateApplyMyDiscount(req.body);
    if (error) {
        return res.status(400).json({ message: error.details[0].message });
    }

    const { userId } = value;
    const userDiscount = await UserDiscount.findOne({ userId });

    if (!userDiscount) {
        return res.status(404).json({ message: 'No discount assigned to your account' });
    }

    if (!userDiscount.isActive) {
        return res.status(400).json({ message: 'Your discount is inactive' });
    }

    if (!isDiscountValid(userDiscount)) {
        return res.status(400).json({ message: 'Your discount has expired' });
    }

    const { discountAmount, finalPrice } = calculateDiscount(
        value.deliveryPrice,
        'percentage',
        userDiscount.discountPercentage
    );

    return res.status(200).json({
        originalPrice: value.deliveryPrice,
        discountPercentage: userDiscount.discountPercentage,
        discountAmount,
        finalPrice,
        isPermanent: userDiscount.isPermanent,
        expiresAt: userDiscount.expiresAt || null,
    });
});

// ─── Admin: Discount Codes ────────────────────────────────────────────────────

/**
 * @desc  Create a new discount code
 * @route POST /api/discounts/codes
 * @access Admin
 */
const createDiscountCode = asyncHandler(async (req, res) => {
    const { error, value } = validateCreateDiscountCode(req.body);
    if (error) {
        return res.status(400).json({ message: error.details.map((d) => d.message).join('; ') });
    }

    if (value.type === 'percentage' && value.value > 100) {
        return res.status(400).json({ message: 'Percentage discount value cannot exceed 100' });
    }

    if (!value.isPermanent && !value.expiresAt) {
        return res.status(400).json({ message: 'expiresAt is required when isPermanent is false' });
    }

    if (!value.isPermanent && value.expiresAt && new Date(value.expiresAt) <= new Date()) {
        return res.status(400).json({ message: 'expiresAt must be a future date' });
    }

    const existing = await DiscountCode.findOne({ code: value.code.toUpperCase() });
    if (existing) {
        return res.status(409).json({ message: `Discount code "${value.code.toUpperCase()}" already exists` });
    }

    const discount = await DiscountCode.create({
        ...value,
        code: value.code.toUpperCase(),
    });

    return res.status(201).json(discount);
});

/**
 * @desc  List all discount codes
 * @route GET /api/discounts/codes
 * @access Admin
 */
const listDiscountCodes = asyncHandler(async (req, res) => {
    const discounts = await DiscountCode.find().sort({ createdAt: -1 });
    return res.status(200).json(discounts);
});

/**
 * @desc  Get a single discount code by ID
 * @route GET /api/discounts/codes/:id
 * @access Admin
 */
const getDiscountCodeById = asyncHandler(async (req, res) => {
    const discount = await DiscountCode.findById(req.params.id);
    if (!discount) {
        return res.status(404).json({ message: 'Discount code not found' });
    }
    return res.status(200).json(discount);
});

/**
 * @desc  Update a discount code
 * @route PUT /api/discounts/codes/:id
 * @access Admin
 */
const updateDiscountCode = asyncHandler(async (req, res) => {
    const { error, value } = validateUpdateDiscountCode(req.body);
    if (error) {
        return res.status(400).json({ message: error.details.map((d) => d.message).join('; ') });
    }

    if (value.type === 'percentage' && value.value !== undefined && value.value > 100) {
        return res.status(400).json({ message: 'Percentage discount value cannot exceed 100' });
    }

    const discount = await DiscountCode.findByIdAndUpdate(
        req.params.id,
        { $set: value },
        { new: true, runValidators: true }
    );

    if (!discount) {
        return res.status(404).json({ message: 'Discount code not found' });
    }

    return res.status(200).json(discount);
});

/**
 * @desc  Delete a discount code
 * @route DELETE /api/discounts/codes/:id
 * @access Admin
 */
const deleteDiscountCode = asyncHandler(async (req, res) => {
    const discount = await DiscountCode.findByIdAndDelete(req.params.id);
    if (!discount) {
        return res.status(404).json({ message: 'Discount code not found' });
    }
    return res.status(200).json({ message: 'Discount code deleted successfully', code: discount.code });
});

// ─── Admin: User Discounts ────────────────────────────────────────────────────

/**
 * @desc  Assign (or update) a personal discount to a specific user
 * @route POST /api/discounts/users
 * @access Admin
 */
const assignUserDiscount = asyncHandler(async (req, res) => {
    const { error, value } = validateAssignUserDiscount(req.body);
    if (error) {
        return res.status(400).json({ message: error.details.map((d) => d.message).join('; ') });
    }

    if (!value.isPermanent && !value.expiresAt) {
        return res.status(400).json({ message: 'expiresAt is required when isPermanent is false' });
    }

    if (!value.isPermanent && value.expiresAt && new Date(value.expiresAt) <= new Date()) {
        return res.status(400).json({ message: 'expiresAt must be a future date' });
    }

    const userDiscount = await UserDiscount.findOneAndUpdate(
        { userId: value.userId },
        {
            $set: {
                discountPercentage: value.discountPercentage,
                isPermanent: value.isPermanent,
                expiresAt: value.isPermanent ? null : value.expiresAt,
                isActive: true,
                assignedBy: req.user.id,
                note: value.note || '',
            },
        },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    return res.status(201).json({
        message: 'Discount assigned successfully',
        data: userDiscount,
    });
});

/**
 * @desc  List all users that have assigned discounts
 * @route GET /api/discounts/users
 * @access Admin
 */
const listUserDiscounts = asyncHandler(async (req, res) => {
    const userDiscounts = await UserDiscount.find().sort({ createdAt: -1 });
    return res.status(200).json(userDiscounts);
});

/**
 * @desc  Get a specific user's assigned discount
 * @route GET /api/discounts/users/:userId
 * @access Admin
 */
const getUserDiscount = asyncHandler(async (req, res) => {
    const userDiscount = await UserDiscount.findOne({ userId: req.params.userId });
    if (!userDiscount) {
        return res.status(404).json({ message: 'No discount found for this user' });
    }
    return res.status(200).json(userDiscount);
});

/**
 * @desc  Update a user's personal discount
 * @route PUT /api/discounts/users/:userId
 * @access Admin
 */
const updateUserDiscount = asyncHandler(async (req, res) => {
    const { error, value } = validateUpdateUserDiscount(req.body);
    if (error) {
        return res.status(400).json({ message: error.details.map((d) => d.message).join('; ') });
    }

    if (value.isPermanent === false && !value.expiresAt) {
        return res.status(400).json({ message: 'expiresAt is required when isPermanent is false' });
    }

    const userDiscount = await UserDiscount.findOneAndUpdate(
        { userId: req.params.userId },
        { $set: value },
        { new: true, runValidators: true }
    );

    if (!userDiscount) {
        return res.status(404).json({ message: 'No discount found for this user' });
    }

    return res.status(200).json(userDiscount);
});

/**
 * @desc  Remove a user's personal discount
 * @route DELETE /api/discounts/users/:userId
 * @access Admin
 */
const deleteUserDiscount = asyncHandler(async (req, res) => {
    const userDiscount = await UserDiscount.findOneAndDelete({ userId: req.params.userId });
    if (!userDiscount) {
        return res.status(404).json({ message: 'No discount found for this user' });
    }
    return res.status(200).json({ message: 'User discount removed successfully', userId: req.params.userId });
});

// ─── Global Discount Controllers ──────────────────────────────────────────────

/**
 * [Admin] Get the current global discount configuration
 * GET /api/discounts/global
 */
const getGlobalDiscount = async (req, res) => {
    try {
        const globalDiscount = await getOrCreateGlobalDiscount();
        const responseData = globalDiscount.toObject ? globalDiscount.toObject() : { ...globalDiscount };
        responseData.usedCount = (globalDiscount.usedByUserIds || []).length;
        return res.status(200).json(responseData);
    } catch (error) {
        return res.status(500).json({ message: 'Error retrieving global discount', error: error.message });
    }
};

/**
 * [Admin] Update the global discount configuration
 * PUT /api/discounts/global
 */
const updateGlobalDiscount = async (req, res) => {
    try {
        const { error, value } = validateUpdateGlobalDiscount(req.body);
        if (error) {
            return res.status(400).json({ message: error.details[0].message });
        }

        const globalDiscount = await getOrCreateGlobalDiscount();

        if (value.discountPercentage !== undefined) globalDiscount.discountPercentage = value.discountPercentage;
        if (value.isActive !== undefined) globalDiscount.isActive = value.isActive;
        if (value.expiresAt !== undefined) globalDiscount.expiresAt = value.expiresAt;
        if (value.isOneTimeOnly !== undefined) globalDiscount.isOneTimeOnly = value.isOneTimeOnly;
        if (value.resetUsedUsers === true) globalDiscount.usedByUserIds = [];

        await globalDiscount.save();

        const responseData = globalDiscount.toObject ? globalDiscount.toObject() : { ...globalDiscount };
        responseData.usedCount = (globalDiscount.usedByUserIds || []).length;

        return res.status(200).json({ message: 'Global discount updated successfully', globalDiscount: responseData });
    } catch (error) {
        return res.status(500).json({ message: 'Error updating global discount', error: error.message });
    }
};

/**
 * [Public/User] Get the active global discount (if any)
 * GET /api/discounts/global-active
 */
const getActiveGlobalDiscount = async (req, res) => {
    try {
        const globalDiscount = await getOrCreateGlobalDiscount();
        
        // Check if it is active
        if (!globalDiscount.isActive) {
            return res.status(200).json({ hasActiveGlobalDiscount: false });
        }
        
        // Check if it is expired (if expiresAt is set)
        if (globalDiscount.expiresAt && new Date() > new Date(globalDiscount.expiresAt)) {
            return res.status(200).json({ hasActiveGlobalDiscount: false });
        }

        const userId = req.query.userId || (req.user && (req.user.id || req.user._id));
        const uid = userId ? String(userId).trim() : null;

        // Check one-time per user
        if (globalDiscount.isOneTimeOnly) {
            if (uid && Array.isArray(globalDiscount.usedByUserIds) && globalDiscount.usedByUserIds.includes(uid)) {
                return res.status(200).json({
                    hasActiveGlobalDiscount: false,
                    alreadyUsed: true,
                    isOneTimeOnly: true,
                    discountPercentage: globalDiscount.discountPercentage,
                    message: 'تم استخدام الخصم العام بالفعل'
                });
            }

            return res.status(200).json({
                hasActiveGlobalDiscount: true,
                discountPercentage: globalDiscount.discountPercentage,
                expiresAt: globalDiscount.expiresAt,
                isOneTimeOnly: true,
                alreadyUsed: false
            });
        }

        return res.status(200).json({
            hasActiveGlobalDiscount: true,
            discountPercentage: globalDiscount.discountPercentage,
            expiresAt: globalDiscount.expiresAt,
            isOneTimeOnly: false,
            alreadyUsed: false
        });
    } catch (error) {
        return res.status(500).json({ message: 'Error checking global discount', error: error.message });
    }
};

module.exports = {
    applyDiscountCode,
    getMyDiscount,
    applyMyDiscount,
    createDiscountCode,
    listDiscountCodes,
    getDiscountCodeById,
    updateDiscountCode,
    deleteDiscountCode,
    assignUserDiscount,
    listUserDiscounts,
    getUserDiscount,
    updateUserDiscount,
    deleteUserDiscount,
    getGlobalDiscount,
    updateGlobalDiscount,
    getActiveGlobalDiscount,
};
