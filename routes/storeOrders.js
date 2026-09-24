const express = require('express');
const router = express.Router();

const {
    checkout,
    getMyOrders,
    getOrderById,
    getOrdersByGroup,
    getStoreOrderTrack,
    getAllOrders,
    updateOrderStatus,
    cancelOrder,
    cancelOrderGroup,
    // ─── Return System (نظام الاسترجاع) ─────────────────────────
    checkReturnEligibility,
    requestStoreOrderReturn,
    cancelStoreOrderReturn,
    // ─── Representative ───────────────────────────────────────
    getRepresentativeOrders,
    getRepresentativeMyOrders,
    acceptStoreOrder,
    releaseStoreOrder,
    updateRepresentativeStoreOrderStatus,
    uploadStoreOrderPhoto,
} = require('../Controllers/storeOrderController');

const { adminDashboard, adminBestSellers, agentProductStats, agentDashboard } = require('../Controllers/storeDashboardController');
const { getAdminOrderFinancialStats } = require('../Controllers/orderController');

const { verifyToken } = require('../middlewares/verifytoken');
const { authorizeRoles } = require('../middlewares/authorize');
const { otpVerificationLimiter } = require('../middlewares/rateLimiter');
const podController = require('../Controllers/podController');

// ─── Admin Dashboard ──────────────────────────────────────────────────────────
router.get('/admin/financial-stats', verifyToken, authorizeRoles('Admin', 'Administration'), getAdminOrderFinancialStats);
router.get('/admin/dashboard', verifyToken, authorizeRoles('Admin', 'Administration'), adminDashboard);

// ─── Admin: Best-sellers with full inventory stats ────────────────────────────
// GET /api/store/orders/admin/best-sellers?limit=20&agentId=...&category=...
router.get('/admin/best-sellers', verifyToken, authorizeRoles('Admin'), adminBestSellers);

// ─── Admin: Per-agent product inventory stats ─────────────────────────────────
// GET /api/store/orders/admin/agent-stats/:agentId?sortBy=totalSold|stock|name
router.get('/admin/agent-stats/:agentId', verifyToken, authorizeRoles('Admin'), agentProductStats);

// ─── Agent Dashboard ──────────────────────────────────────────────────────────
router.get('/agent/dashboard', verifyToken, authorizeRoles('Admin', 'Agent'), agentDashboard);

// ─── Representative: Available orders (pending by default) ───────────────────
// GET /api/store/orders/representative/pending?status=pending,confirmed&page=1&limit=50
router.get('/representative/pending', verifyToken, authorizeRoles('Admin', 'Representative'), getRepresentativeOrders);

// ─── Representative: My accepted orders ──────────────────────────────────────
// GET /api/store/orders/representative/my?status=confirmed,processing&page=1&limit=50
router.get('/representative/my', verifyToken, authorizeRoles('Admin', 'Representative'), getRepresentativeMyOrders);

// 📍 Representative: Accept a pending order → confirmed 📍
// PATCH /api/store/orders/:id/accept
router.patch('/:id/accept', verifyToken, authorizeRoles('Admin', 'Representative'), acceptStoreOrder);

// 📍 Representative: Release an accepted order back to pending 📍
// PATCH /api/store/orders/:id/release
router.patch('/:id/release', verifyToken, authorizeRoles('Admin', 'Representative'), releaseStoreOrder);

// ─── Representative: Update status (processing/shipped/delivered/cancelled) ───
// PATCH /api/store/orders/:id/representative-status
router.patch('/:id/representative-status', verifyToken, authorizeRoles('Admin', 'Representative'), updateRepresentativeStoreOrderStatus);

// ─── Representative: Upload photo (pickup/delivery) ──────────────────────────
// POST /api/store/orders/:id/photo/:stage
router.post('/:id/photo/:stage', verifyToken, authorizeRoles('Admin', 'Representative'), uploadStoreOrderPhoto);

// ─── Admin: All orders ────────────────────────────────────────────────────────
router.get('/', verifyToken, authorizeRoles('Admin', 'Agent', 'Administration'), getAllOrders);

// ─── Admin/Agent: Update order status ────────────────────────────────────────
router.patch('/:id/status', verifyToken, authorizeRoles('Admin', 'Agent'), updateOrderStatus);

// ─── Client: Checkout (create split orders from cart) ────────────────────────
router.post('/checkout', verifyToken, authorizeRoles('NormalUser'), checkout);

// ─── Client: My orders ───────────────────────────────────────────────────────
router.get('/my', verifyToken, authorizeRoles('NormalUser'), getMyOrders);

// ─── Client: Cancel own pending order ────────────────────────────────────────
router.patch('/:id/cancel', verifyToken, authorizeRoles('NormalUser'), cancelOrder);

// ─── Client: Cancel all pending sub-orders in a group ────────────────────────
router.patch('/group/:groupId/cancel', verifyToken, authorizeRoles('NormalUser'), cancelOrderGroup);

// ─── Client: Store Order Returns (نظام الاسترجاع خلال 48 ساعة) ─────────────
// GET   /api/store/orders/:id/return-eligibility  → فحص الأهلية ومدة الـ 48 ساعة وسعر التوصيل
// POST  /api/store/orders/:id/request-return      → تأكيد طلب الاسترجاع وتحويله لـ return_pending
// PATCH /api/store/orders/:id/cancel-return       → إلغاء طلب الاسترجاع قبل قبول المندوب
router.get('/:id/return-eligibility', verifyToken, authorizeRoles('NormalUser', 'Admin'), checkReturnEligibility);
router.post('/:id/request-return', verifyToken, authorizeRoles('NormalUser', 'Admin'), requestStoreOrderReturn);
router.patch('/:id/cancel-return', verifyToken, authorizeRoles('NormalUser', 'Admin'), cancelStoreOrderReturn);

// ─── PoD V2 (Static confirmations routes FIRST before /:id) ───────────────────
router.get('/pod/confirmations', verifyToken, podController.getCustomerConfirmations);
router.get('/delivery-session/confirmations', verifyToken, podController.getCustomerConfirmations);

// ─── Shared: Get all sub-orders by parentGroupId (Rep / Admin / Client owner) ─
router.get('/group/:groupId', verifyToken, getOrdersByGroup);

// ─── Business Order Sequential Tracking (Stops / Phase) ───────────────────────
router.get('/:id/track', verifyToken, getStoreOrderTrack);

// ─── Shared: Get order by ID (owner or admin/agent/rep) ──────────────────────
router.get('/:id', verifyToken, getOrderById);

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
