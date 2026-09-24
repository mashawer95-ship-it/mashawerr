const express = require('express');
const router = express.Router();
const { getStorePricing, updateStorePricing, calculateDeliveryPrice } = require('../Controllers/storePricingController');
const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');

// Users and Admins can view pricing
router.get('/', verifyToken, getStorePricing);

// Calculate price endpoint for checkout
router.post('/calculate', verifyToken, calculateDeliveryPrice);

// Only admins can update pricing
router.put('/', verifyTokenAndAdmin, updateStorePricing);

module.exports = router;
