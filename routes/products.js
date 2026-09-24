const express = require('express');
const router = express.Router();

const {
    createProduct,
    assignAgents,
    getAllProducts,
    getProductById,
    updateProduct,
    deleteProduct,
    updateStock,
    getCategories,
    getBestSellers,
    setPickupLocation,
    clearOverridesTemporary,
} = require('../Controllers/productController');

const { rateProduct, getProductRatings } = require('../Controllers/ratingController');

const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');
const { authorizeRoles, adminOrAgent, adminOnly } = require('../middlewares/authorize');
const { uploadProductImages } = require('../middlewares/uploadProduct');

// ─── Static routes first (must be before /:id) ───────────────────────────────
router.get('/clear-overrides-temp', verifyTokenAndAdmin, clearOverridesTemporary);
router.get('/categories', verifyToken, getCategories);
router.get('/best-sellers', verifyToken, getBestSellers);

// ─── Public-ish (token required, any role) ───────────────────────────────────
router.get('/', verifyToken, getAllProducts);
router.get('/:id', verifyToken, getProductById);

// ─── Ratings (any authenticated user can read; must have purchased to write) ─
router.post('/:id/rate', verifyToken, rateProduct);
router.get('/:id/ratings', verifyToken, getProductRatings);

// ─── Admin & Agent ────────────────────────────────────────────────────────────
router.put(
    '/:id',
    adminOrAgent,
    uploadProductImages,
    updateProduct
);

router.patch(
    '/:id/stock',
    adminOrAgent,
    updateStock
);

// Agent or admin sets pickup location for a product
router.patch(
    '/:id/pickup-location',
    adminOrAgent,
    setPickupLocation
);

// ─── Admin only ───────────────────────────────────────────────────────────────
router.post(
    '/',
    adminOnly,
    uploadProductImages,
    createProduct
);

router.post(
    '/:id/assign',
    adminOnly,
    assignAgents
);

router.delete(
    '/:id',
    adminOnly,
    deleteProduct
);

module.exports = router;
