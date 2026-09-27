const express = require('express');
const router = express.Router();
const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');
const {
    getRepCommission,
    updateRepCommission,
} = require('../Controllers/repCommissionController');

// GET /api/rep-commission — جلب إعدادات العمولة الحالية (عام للقراءة)
router.get('/', getRepCommission);

// PUT /api/rep-commission — تحديث نسب العمولة (Admin)
router.put('/', verifyTokenAndAdmin, updateRepCommission);

module.exports = router;
