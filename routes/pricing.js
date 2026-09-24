const express = require('express');
const router = express.Router();
const { calculatePrice, updatePricing, getPricing } = require('../Controllers/pricingController');
const { verifyTokenAndAdmin } = require('../middlewares/verifytoken');

// GET + calculate-price: public / any user
router.get('/', getPricing);
router.post('/calculate-price', calculatePrice);
router.put('/', verifyTokenAndAdmin, updatePricing);

module.exports = router;
