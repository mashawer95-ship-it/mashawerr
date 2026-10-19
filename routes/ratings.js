const express = require('express');
const router  = express.Router();

const {
    submitUserRating,
    getUserRatings,
    getOrderRatings,
    getPendingRating,
    skipOrderRating,
} = require('../Controllers/userRatingController');

const { verifyToken } = require('../middlewares/verifytoken');

// GET  /api/ratings/pending                — فحص وجود تقييم معلق لم يكتمل للعميل أو المندوب
router.get('/pending', verifyToken, getPendingRating);

// POST /api/ratings/order/:orderId/skip   — تخطي تقييم هذا الأوردر من قِبل المستخدم
router.post('/order/:orderId/skip', verifyToken, skipOrderRating);
router.post('/skip/:orderId', verifyToken, skipOrderRating);

// POST /api/ratings/order/:orderId        — تقديم تقييم بعد اكتمال الأوردر
router.post('/order/:orderId', verifyToken, submitUserRating);

// POST /api/ratings                       — تقديم تقييم (orderId في الـ body أو يكتشف تلقائياً)
router.post('/', verifyToken, submitUserRating);

// GET  /api/ratings/order/:orderId        — جلب كل تقييمات أوردر معين
router.get('/order/:orderId', verifyToken, getOrderRatings);

// GET  /api/ratings/user/:userId          — جلب تقييمات مستخدم معين + متوسطه
router.get('/user/:userId', verifyToken, getUserRatings);

module.exports = router;
