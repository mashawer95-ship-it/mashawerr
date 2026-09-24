const express = require('express');
const router = express.Router();

const {
    submitFeedback,
    getAllFeedback,
    deleteFeedback,
    updateFeedbackStatus,
} = require('../Controllers/feedbackController');

const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');

// POST /api/feedback - إرسال رأي أو مشكلة للمستخدمين
router.post('/', verifyToken, submitFeedback);

// GET /api/feedback - جلب كل الآراء والمشاكل للإدارة مع بيانات الحساب
router.get('/', verifyTokenAndAdmin, getAllFeedback);

// DELETE /api/feedback/:id - حذف رأي/ملاحظة
router.delete('/:id', verifyTokenAndAdmin, deleteFeedback);

// PATCH /api/feedback/:id/status - تحديث حالة الملاحظة
router.patch('/:id/status', verifyTokenAndAdmin, updateFeedbackStatus);

module.exports = router;
