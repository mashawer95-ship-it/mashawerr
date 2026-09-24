const express = require('express');
const router  = express.Router();

const {
    submitUserRating,
    getUserRatings,
    getOrderRatings,
} = require('../Controllers/userRatingController');

const { verifyToken } = require('../middlewares/verifytoken');

// POST /api/ratings/order/:orderId        — تقديم تقييم بعد اكتمال الأوردر
router.post('/order/:orderId', verifyToken, submitUserRating);

// GET  /api/ratings/order/:orderId        — جلب كل تقييمات أوردر معين
router.get('/order/:orderId', verifyToken, getOrderRatings);

// GET  /api/ratings/user/:userId          — جلب تقييمات مستخدم معين + متوسطه
router.get('/user/:userId', verifyToken, getUserRatings);

module.exports = router;
