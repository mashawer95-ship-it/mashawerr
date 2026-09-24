const express = require('express');
const router = express.Router();
const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');
const {
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
} = require('../Controllers/discountController');

// ─── User Routes (Public — no auth, userId passed directly) ──────────────────

// Apply a public discount code to a delivery price
router.post('/apply-code', applyDiscountCode);

// Get personal discount info by userId query param: ?userId=
router.get('/my-discount', getMyDiscount);

// Apply personal discount to a delivery price
router.post('/my-discount/apply', applyMyDiscount);

// Get the active global discount (if any)
router.get('/global-active', getActiveGlobalDiscount);

// ─── Admin Routes (Admin JWT required) ───────────────────────────────────────

// Discount Codes CRUD
router.post('/codes', verifyTokenAndAdmin, createDiscountCode);
router.get('/codes', verifyTokenAndAdmin, listDiscountCodes);
router.get('/codes/:id', verifyTokenAndAdmin, getDiscountCodeById);
router.put('/codes/:id', verifyTokenAndAdmin, updateDiscountCode);
router.delete('/codes/:id', verifyTokenAndAdmin, deleteDiscountCode);

// User Discounts CRUD
router.post('/users', verifyTokenAndAdmin, assignUserDiscount);
router.get('/users', verifyTokenAndAdmin, listUserDiscounts);
router.get('/users/:userId', verifyTokenAndAdmin, getUserDiscount);
router.put('/users/:userId', verifyTokenAndAdmin, updateUserDiscount);
router.delete('/users/:userId', verifyTokenAndAdmin, deleteUserDiscount);

// Global Discount
router.get('/global', verifyTokenAndAdmin, getGlobalDiscount);
router.put('/global', verifyTokenAndAdmin, updateGlobalDiscount);

module.exports = router;
