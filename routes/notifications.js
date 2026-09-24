const express = require('express');
const router = express.Router();
const {
    saveToken,
    getAllUsers,
    sendToUser,
    sendToAll,
    deleteUser,
    testNotify,
    getMyNotifications,
    deleteAllMyNotifications,
    deleteNotificationById,
    markNotificationAsRead
} = require('../Controllers/notificationController');
const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');

/** Middleware: require Admin JWT role OR x-admin-key header matching ADMIN_KEY env var. */
function requireAdminKey(req, res, next) {
    // 1. Check x-admin-key header (for automated server-to-server/cron scripts)
    const expected = process.env.ADMIN_KEY ? String(process.env.ADMIN_KEY).trim() : '';
    const key =
        req.headers['x-admin-key'] != null ? String(req.headers['x-admin-key']).trim() : '';
    if (expected && key && key === expected) {
        return next();
    }

    // 2. Check if caller is authenticated as Admin via JWT
    verifyTokenAndAdmin(req, res, (err) => {
        if (!err && (req.user?.isAdmin || req.user?.userType === 'admin')) {
            return next();
        }
        return res.status(401).json({ message: 'Unauthorized: Admin privileges or valid admin key required' });
    });
}

// POST /api/notifications/save-token
router.post('/save-token', saveToken);

// GET /api/notifications/users
router.get('/users', getAllUsers);

// POST /api/notifications/send-to-user
router.post('/send-to-user', sendToUser);

// POST /api/notifications/send-to-all  (admin key required)
router.post('/send-to-all', requireAdminKey, sendToAll);

// DELETE /api/notifications/delete-user/:userId
router.delete('/delete-user/:userId', deleteUser);

// POST /api/notifications/test-notify  (diagnostic)
router.post('/test-notify', testNotify);

// ─── User Facing Endpoints ───────────────────────────────────────────────────

// GET /api/notifications/my-notifications
router.get('/my-notifications', verifyToken, getMyNotifications);

// DELETE /api/notifications/my-notifications
router.delete('/my-notifications', verifyToken, deleteAllMyNotifications);

// DELETE /api/notifications/:id
router.delete('/:id', verifyToken, deleteNotificationById);

// PATCH /api/notifications/:id/read
router.patch('/:id/read', verifyToken, markNotificationAsRead);

module.exports = router;
