const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams: inherit :orderId
const {
    markTaskPickedUp,
    uploadPhotoBefore,
    deliverTask,
    getTaskStatus,
} = require('../Controllers/taskController');

const { verifyToken } = require('../middlewares/verifytoken');

// PATCH /api/orders/:orderId/tasks/:taskId/pickup
// تم الاستلام — يحول taskStatus إلى picked_up
router.patch('/:taskId/pickup', verifyToken, markTaskPickedUp);

// POST  /api/orders/:orderId/tasks/:taskId/photo/before
// رفع صورة الاستلام (itemPhotoBefore) — multipart/form-data field: photo
router.post('/:taskId/photo/before', verifyToken, uploadPhotoBefore);

// POST  /api/orders/:orderId/tasks/:taskId/deliver
// تم التسليم — يحول taskStatus إلى completed + رفع صورة التسليم (اختياري)
// لو كل التاسكات completed → الأوردر يتحول لـ completed
router.post('/:taskId/deliver', verifyToken, deliverTask);

// GET   /api/orders/:orderId/tasks/:taskId/status
// جلب حالة تاسك معين (خفيف — بدون كل بيانات الأوردر)
router.get('/:taskId/status', verifyToken, getTaskStatus);

module.exports = router;
