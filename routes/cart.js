const express = require('express');
const router = express.Router();

const {
    getCart,
    addToCart,
    updateCartItem,
    removeFromCart,
    clearCart,
    setItemDeliveryLocation,
} = require('../Controllers/cartController');

const { verifyToken } = require('../middlewares/verifytoken');
const { authorizeRoles } = require('../middlewares/authorize');

// Cart is client-only (NormalUser); admins don't shop
router.get('/', verifyToken, authorizeRoles('NormalUser'), getCart);
router.post('/', verifyToken, authorizeRoles('NormalUser'), addToCart);
router.put('/:productId', verifyToken, authorizeRoles('NormalUser'), updateCartItem);
router.delete('/:productId', verifyToken, authorizeRoles('NormalUser'), removeFromCart);
router.delete('/', verifyToken, authorizeRoles('NormalUser'), clearCart);

// ─── Per-item delivery location ──────────────────────────────────────────────
// Client sets a specific delivery pin for a product already in the cart.
router.patch('/:productId/delivery-location', verifyToken, authorizeRoles('NormalUser'), setItemDeliveryLocation);

module.exports = router;
