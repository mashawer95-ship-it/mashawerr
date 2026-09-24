const express = require('express');
const router = express.Router();
const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');
const { authorize } = require('../middlewares/authorize');
const { otpVerificationLimiter } = require('../middlewares/rateLimiter');
const podController = require('../Controllers/podController');
const {
    listOrders,
    listOrdersByUserId,
    listOrdersByRepresentativeId,
    listWaitingOrders,
    createOrder,
    getOrderById,
    updateOrderStatus,
    getOrderStatus,
    cancelOrder,
    acceptOrder,
    releaseOrder,
    confirmArrival,
    markClientDelayed,
    getOrderRoute,
    searchOrderByNumber,
    getAdminOrderFinancialStats,
    getActiveOrders,
} = require('../Controllers/orderController');

router.get('/admin/financial-stats', verifyToken, authorize('admin', 'administration'), getAdminOrderFinancialStats);
router.get('/search-by-number', verifyToken, searchOrderByNumber);
router.get('/', verifyToken, authorize('admin', 'administration'), listOrders);

router.post('/', verifyToken, createOrder);
router.get('/active', verifyToken, getActiveOrders);                                 // GET  /api/orders/active   — للعميل: الطلبات النشطة (الحد 2)
router.get('/waiting', verifyToken, listWaitingOrders);                              // GET  /api/orders/waiting  — للمندوب: قائمة الطلبات المتاحة
router.get('/user/:userId', verifyToken, listOrdersByUserId);                        // GET  /api/orders/user/:userId  — للعميل: جميع طلباته
router.get('/representative/:repId', verifyToken, listOrdersByRepresentativeId);     // GET  /api/orders/representative/:repId — للمندوب: جميع طلباته
// ─── PoD V2 (Static confirmations routes FIRST before /:id) ───────────────────
router.get('/pod/confirmations', verifyToken, podController.getCustomerConfirmations);
router.get('/delivery-session/confirmations', verifyToken, podController.getCustomerConfirmations);

router.get('/:id', verifyToken, getOrderById);
router.get('/:id/status', verifyToken, getOrderStatus);
router.patch('/:id/status', verifyTokenAndAdmin, updateOrderStatus);
router.patch('/:id/accept', verifyToken, acceptOrder);           // PATCH /api/orders/:id/accept  — قبول الطلب
router.patch('/:id/release', verifyToken, releaseOrder);         // PATCH /api/orders/:id/release — تحرير الطلب → waiting
router.patch('/:id/confirm-arrival', verifyToken, confirmArrival); // PATCH /api/orders/:id/confirm-arrival — تأكيد الوصول وبدء التايمر
router.patch('/:id/mark-delayed', verifyToken, markClientDelayed); // PATCH /api/orders/:id/mark-delayed — العميل تأخر
router.post('/:id/cancel', verifyToken, cancelOrder);
router.get('/:id/route', verifyToken, getOrderRoute);

// ─── PoD V2 (Dynamic /:id routes) ─────────────────────────────────────────────
router.get('/:id/delivery-session/status', verifyToken, podController.getSessionStatus);
router.get('/:id/delivery-session/upload-url', verifyToken, podController.getUploadUrl);
router.post('/:id/delivery-session/:sessionId/attempts', verifyToken, podController.createAttempt);
router.post('/:id/delivery-session/review', verifyToken, podController.reviewAttempt);
router.post('/:id/delivery-session/:sessionId/review', verifyToken, podController.reviewAttempt);
router.post('/:id/delivery-session/:sessionId/attempts/:attemptId/review', verifyToken, podController.reviewAttempt);
router.post('/:id/delivery-session/re-notify', verifyToken, podController.renotifyCustomer);
router.post('/:id/delivery-session/:sessionId/re-notify', verifyToken, podController.renotifyCustomer);
router.post('/:id/delivery-session/resend-otp', verifyToken, podController.resendOTP);
router.post('/:id/delivery-session/verify', verifyToken, otpVerificationLimiter, podController.verifyOTP);
router.post('/:id/delivery-session/:sessionId/verify', verifyToken, otpVerificationLimiter, podController.verifyOTP);

module.exports = router;

