const express = require('express');
const router = express.Router();

const { toggleFavorite, getMyFavorites, checkFavorite } = require('../Controllers/favoriteController');
const { verifyToken } = require('../middlewares/verifytoken');

// All favorites endpoints require a valid token
router.use(verifyToken);

/**
 * GET /api/store/favorites
 * Returns the current user's favorited products (paginated)
 */
router.get('/', getMyFavorites);

/**
 * GET /api/store/favorites/check/:productId
 * Returns { productId, isFavorited: bool } for a single product
 */
router.get('/check/:productId', checkFavorite);

/**
 * POST /api/store/favorites/:productId
 * Toggle: adds the product if not favorited, removes it if already favorited
 */
router.post('/:productId', toggleFavorite);

module.exports = router;
