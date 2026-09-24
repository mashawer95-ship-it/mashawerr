const router = require('express').Router();
const { verifyToken } = require('../middlewares/verifytoken');
const { uploadChatMedia } = require('../middlewares/chatUpload');
const { getChatHistory, getUnreadForOrder, getTotalUnread, uploadChatAttachment } = require('../Controllers/chatController');

/**
 * @route   POST /api/chat/upload
 * @desc    Upload chat photo or voice record attachment
 * @access  Private
 */
router.post('/upload', verifyToken, uploadChatMedia, uploadChatAttachment);

/**
 * @route   GET /api/chat/unread
 * @desc    Total unread count across ALL orders (badge on main tab)
 * @access  Private
 * @query   orderId (optional) – filter to a single order
 */
router.get('/unread', verifyToken, getTotalUnread);

/**
 * @route   GET /api/chat/:orderId
 * @desc    Get chat history for an order
 * @access  Private
 */
router.get('/:orderId', verifyToken, getChatHistory);

/**
 * @route   GET /api/chat/:orderId/unread
 * @desc    Unread count for ONE specific order (badge on that order's chat icon)
 * @access  Private
 */
router.get('/:orderId/unread', verifyToken, getUnreadForOrder);

module.exports = router;
