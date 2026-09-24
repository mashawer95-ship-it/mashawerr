const express = require('express');
const router = express.Router();

const {
    createRestaurant,
    getAllRestaurants,
    getRestaurantById,
    updateRestaurant,
    deleteRestaurant,
    getRestaurantProducts,
    setRestaurantLocation,
} = require('../Controllers/restaurantController');

const { verifyToken } = require('../middlewares/verifytoken');
const { adminOnly } = require('../middlewares/authorize');
const { uploadRestaurantLogo } = require('../middlewares/uploadRestaurant');

// ─── Public-ish (token required, any authenticated role) ─────────────────────
router.get('/', verifyToken, getAllRestaurants);
router.get('/:id', verifyToken, getRestaurantById);
router.get('/:id/products', verifyToken, getRestaurantProducts);

// ─── Admin only ───────────────────────────────────────────────────────────────
router.post('/', adminOnly, uploadRestaurantLogo, createRestaurant);
router.put('/:id', adminOnly, uploadRestaurantLogo, updateRestaurant);
router.delete('/:id', adminOnly, deleteRestaurant);

// Admin sets the pickup location for the restaurant (where rep picks up from)
router.patch('/:id/location', adminOnly, setRestaurantLocation);

module.exports = router;
