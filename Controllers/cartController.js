const path = require('path');
const asyncHandler = require('express-async-handler');
const { Cart, validateAddToCart, validateUpdateCartItem } = require('../middlewares/Cart');
const { Product } = require('../middlewares/Product');
const { buildUrl } = require('../config/urlBuilder');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a full absolute image URL from a stored filename or existing URL.
 */
function buildImageUrl(req, filename) {
    if (!filename) return null;
    if (filename.startsWith('http://') || filename.startsWith('https://')) return filename;
    return buildUrl(req, `products/${path.basename(filename)}`);
}

/**
 * Convert raw filenames in a populated product object to full URLs.
 * Handles both the new `images[]` array and the legacy `image` string field.
 */
function formatProductImages(productObj, req) {
    if (!productObj) return productObj;
    const obj = productObj.toObject ? productObj.toObject() : { ...productObj };

    // Gather raw filenames / URLs from whichever field has data
    let rawImages = [];
    if (Array.isArray(obj.images) && obj.images.length > 0) {
        rawImages = obj.images;
    } else if (obj.image && typeof obj.image === 'string' && obj.image.trim() !== '') {
        rawImages = [obj.image];  // legacy single-image field
    }

    obj.images = rawImages
        .filter(f => f && f.trim() !== '')
        .map(f => buildImageUrl(req, f));

    delete obj.image; // remove legacy field from response
    return obj;
}

/**
 * Map a populated cart's items so every product has full image URLs.
 */
function formatCartItems(cart, req) {
    if (!cart) return null;
    const obj = cart.toObject ? cart.toObject() : { ...cart };
    obj.items = (obj.items || []).map(item => ({
        ...item,
        product: item.product ? formatProductImages(item.product, req) : null,
    }));
    return obj;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * @desc   Get the authenticated user's cart
 * @route  GET /api/store/cart
 */
const getCart = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const cart = await Cart.findOne({ userId })
        .populate('items.product', 'name images image price stock isSoldOut isActive pickupLocation deliveryPricePerMeter deliveryFlatFee associationId restaurantId addons');

    if (!cart) {
        return res.json({ userId, items: [], total: 0 });
    }

    const formatted = formatCartItems(cart, req);
    res.json({
        userId,
        items: formatted.items,
        total: cart.total,
        updatedAt: cart.updatedAt,
    });
});

/**
 * @desc   Add / increment item in cart
 * @route  POST /api/store/cart
 */
const addToCart = asyncHandler(async (req, res) => {
    const { error, value } = validateAddToCart(req.body);
    if (error) return res.status(400).json({ message: error.details.map(d => d.message).join(', ') });

    const { productId, quantity, deliveryLocation, selectedAddons = [] } = value;
    const addonsTotal = (selectedAddons || []).reduce((sum, a) => sum + (Number(a.price) || 0), 0);
    const userId = req.user.id;

    // Check product exists and is available
    const product = await Product.findById(productId);
    if (!product || !product.isActive) return res.status(404).json({ message: 'Product not found' });
    if (product.isSoldOut) return res.status(400).json({ message: 'Product is sold out' });
    if (product.stock < quantity) {
        return res.status(400).json({
            message: `Insufficient stock. Only ${product.stock} unit(s) available.`,
        });
    }

    let cart = await Cart.findOne({ userId });
    if (!cart) cart = new Cart({ userId, items: [] });

    const targetAddonsStr = JSON.stringify((selectedAddons || []).map(a => ({ name: a.name, price: Number(a.price) || 0 })).sort((a, b) => a.name.localeCompare(b.name)));
    const existingItem = cart.items.find(i => {
        if (i.product.toString() !== productId) return false;
        const currentAddonsStr = JSON.stringify((i.selectedAddons || []).map(a => ({ name: a.name, price: Number(a.price) || 0 })).sort((a, b) => a.name.localeCompare(b.name)));
        return currentAddonsStr === targetAddonsStr;
    });

    if (existingItem) {
        const newQty = existingItem.quantity + quantity;
        if (product.stock < newQty) {
            return res.status(400).json({
                message: `Insufficient stock. Only ${product.stock} unit(s) available (${existingItem.quantity} already in cart).`,
            });
        }
        existingItem.quantity = newQty;
        existingItem.addonsTotal = addonsTotal;
        // Update delivery location if provided
        if (deliveryLocation) {
            existingItem.deliveryLocation = deliveryLocation;
        }
    } else {
        cart.items.push({
            product: product._id,
            quantity,
            priceAtAdd: product.price,
            selectedAddons,
            addonsTotal,
            deliveryLocation: deliveryLocation || { lat: null, lng: null, address: '' },
        });
    }

    await cart.save();

    const populated = await Cart.findOne({ userId })
        .populate('items.product', 'name images image price stock isSoldOut isActive pickupLocation deliveryPricePerMeter deliveryFlatFee associationId restaurantId addons');
    const formatted = formatCartItems(populated, req);

    res.status(201).json({
        message: 'Item added to cart',
        cart: { userId, items: formatted.items, total: populated.total },
    });
});

/**
 * @desc   Update quantity of a cart item
 * @route  PUT /api/store/cart/:productId
 */
const updateCartItem = asyncHandler(async (req, res) => {
    const { error, value } = validateUpdateCartItem(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const { quantity, deliveryLocation } = value;
    const userId = req.user.id;
    const { productId } = req.params;

    const cart = await Cart.findOne({ userId });
    if (!cart) return res.status(404).json({ message: 'Cart not found' });

    const item = cart.items.find(i => i.product.toString() === productId);
    if (!item) return res.status(404).json({ message: 'Item not in cart' });

    // Validate against current stock
    const product = await Product.findById(productId);
    if (!product || !product.isActive) return res.status(404).json({ message: 'Product not found' });
    if (product.isSoldOut) return res.status(400).json({ message: 'Product is sold out' });
    if (product.stock < quantity) {
        return res.status(400).json({ message: `Only ${product.stock} unit(s) in stock.` });
    }

    item.quantity = quantity;
    if (deliveryLocation) {
        item.deliveryLocation = deliveryLocation;
    }
    await cart.save();

    const populated = await Cart.findOne({ userId })
        .populate('items.product', 'name images image price stock isSoldOut isActive pickupLocation deliveryPricePerMeter deliveryFlatFee associationId');
    const formatted = formatCartItems(populated, req);

    res.json({
        message: 'Cart updated',
        cart: { userId, items: formatted.items, total: populated.total },
    });
});

/**
 * @desc   Remove an item from cart
 * @route  DELETE /api/store/cart/:productId
 */
const removeFromCart = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { productId } = req.params;

    const cart = await Cart.findOne({ userId });
    if (!cart) return res.status(404).json({ message: 'Cart not found' });

    const beforeLen = cart.items.length;
    cart.items = cart.items.filter(i => i.product.toString() !== productId);

    if (cart.items.length === beforeLen) {
        return res.status(404).json({ message: 'Item not found in cart' });
    }

    await cart.save();
    res.json({ message: 'Item removed from cart', total: cart.total });
});

/**
 * @desc   Clear entire cart
 * @route  DELETE /api/store/cart
 */
const clearCart = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    await Cart.findOneAndDelete({ userId });
    res.json({ message: 'Cart cleared' });
});

/**
 * @desc   Set or update delivery location for a specific cart item
 * @route  PATCH /api/store/cart/:productId/delivery-location
 */
const setItemDeliveryLocation = asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const { productId } = req.params;
    const { lat, lng, address = '' } = req.body;

    if (lat == null || lng == null) {
        return res.status(400).json({ message: 'lat and lng are required' });
    }

    const cart = await Cart.findOne({ userId });
    if (!cart) return res.status(404).json({ message: 'Cart not found' });

    const item = cart.items.find(i => i.product.toString() === productId);
    if (!item) return res.status(404).json({ message: 'Item not in cart' });

    item.deliveryLocation = { lat, lng, address };
    await cart.save();

    res.json({
        message: 'Delivery location set for item',
        productId,
        deliveryLocation: item.deliveryLocation,
    });
});

module.exports = {
    getCart,
    addToCart,
    updateCartItem,
    removeFromCart,
    clearCart,
    setItemDeliveryLocation,
};
