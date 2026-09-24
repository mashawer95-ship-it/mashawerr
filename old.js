const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const joi = require('joi');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const {
    StoreOrder,
    validateCreateStoreOrder,
    validateUpdateStoreOrderStatus,
    getNextStoreOrderId,
} = require('../middlewares/StoreOrder');
const Product = mongoose.models.Product || require('../middlewares/Product').Product;
const { Cart } = require('../middlewares/Cart');
const { User } = require('../middlewares/User');
const { Association } = require('../middlewares/Association');
const { notifyClient } = require('../services/notifyClient');

// ÔöÇÔöÇÔöÇ Multer Setup ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
const storage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
        const id = req.params.id || 'unknown';
        return {
            folder: 'mashawerr/order-photos',
            public_id: `store_order_${id}_${Date.now()}`,
            overwrite: true,
            resource_type: 'image',
            transformation: [{ width: 1000, quality: 'auto', fetch_format: 'auto' }],
        };
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
        allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only JPEG/PNG/WebP allowed'));
    },
});

// ÔöÇÔöÇÔöÇ Helper ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

/**
 * Enriches an order object with:
 *  - productImage: snapshotted at order time; falls back to current product image
 *  - pickupLocation: current pickup location from the Product document
 *    (set by the agent ÔÇö where the driver collects the product)
 * deliveryLocation is already stored on the order itself (set at checkout).
 */
async function enrichOrder(order) {
    const obj = order.toObject ? order.toObject() : { ...order };

    // Collect all unique product IDs from order items
    const productIds = obj.items
        .map(i => i.product?.toString())
        .filter(Boolean);

    // One batch query ÔÇö fetch image + pickupLocation for all products
    let productMap = {};
    if (productIds.length > 0) {
        const products = await Product.find(
            { _id: { $in: productIds } },
            { images: 1, image: 1, pickupLocation: 1 }
        );
        products.forEach(p => {
            const firstImg =
                (Array.isArray(p.images) && p.images.length > 0)
                    ? p.images[0]
                    : (p.image || null);
            productMap[p._id.toString()] = {
                image: firstImg,
                pickupLocation: p.pickupLocation || null,
            };
        });
    }

    obj.items = obj.items.map(item => {
        const pid = item.product?.toString();
        const productData = productMap[pid] || {};
        
        const itemPickup = (item.pickupLocation && item.pickupLocation.lat != null) 
            ? item.pickupLocation 
            : (productData.pickupLocation || null);

        return {
            ...item,
            productImage:    item.productImage || productData.image || null,
            pickupLocation:  itemPickup,
        };
    });

    if (obj.subOrders && obj.subOrders.length > 0) {
        obj.subOrders = obj.subOrders.map(sub => {
            if (sub.items) {
                sub.items = sub.items.map(item => {
                    const pid = item.product?.toString();
                    const productData = productMap[pid] || {};
                    const itemPickup = (item.pickupLocation && item.pickupLocation.lat != null)
                        ? item.pickupLocation
                        : (productData.pickupLocation || null);
                    return {
                        ...item,
                        productImage: item.productImage || productData.image || null,
                        pickupLocation: itemPickup,
                    };
                });

                // Collect all unique pickup locations for this subOrder
                const allPickups = sub.items
                    .filter(i => i.pickupLocation && i.pickupLocation.lat != null)
                    .map(i => i.pickupLocation);

                const uniquePickups = [];
                for (const loc of allPickups) {
                    const isDuplicate = uniquePickups.some(u =>
                        Math.abs(u.lat - loc.lat) < 0.0001 && Math.abs(u.lng - loc.lng) < 0.0001
                    );
                    if (!isDuplicate) uniquePickups.push(loc);
                }

                sub.pickupLocations = uniquePickups;
                sub.hasSinglePickup = uniquePickups.length <= 1;
                sub.pickupLocation = uniquePickups[0] || null;
            }
            return sub;
        });
    }

    // Enrich userInfo with profileImage if missing (for orders created before this field was added)
    if (obj.userId && (!obj.userInfo?.profileImage)) {
        try {
            const customer = await User.findById(obj.userId, { profileImage: 1 });
            if (customer?.profileImage) {
                if (!obj.userInfo) obj.userInfo = {};
                obj.userInfo.profileImage = customer.profileImage;
            }
        } catch (_) { /* non-critical */ }
    }

    return obj;
}

// Keep backward-compatible alias
const enrichOrderImages = enrichOrder;

/** Deduct stock and auto-set isSoldOut for each item in a list */
async function deductStock(items) {
    for (const item of items) {
        const product = await Product.findById(item.product);
        if (!product) throw new Error(`Product ${item.product} not found`);
        if (product.stock < item.quantity) {
            throw new Error(`Insufficient stock for "${product.name}". Available: ${product.stock}`);
        }
        product.stock -= item.quantity;
        // pre-save hook will sync isSoldOut
        await product.save();
    }
}

function groupStoreOrders(orders) {
    const displayOrders = [];
    const seenGroups = {};
    for (let i = 0; i < orders.length; i++) {
        const o = orders[i].toObject ? orders[i].toObject() : { ...orders[i] };
        const gid = o.parentGroupId;
        if (!gid) {
            displayOrders.push(o);
        } else {
            if (!seenGroups[gid]) {
                const parent = { ...o, _id: gid, subOrders: [], items: [...(o.items || [])] };
                const subOrder = { ...o, items: [...(o.items || [])] };
                parent.subOrders.push(subOrder);
                seenGroups[gid] = parent;
                displayOrders.push(parent);
            } else {
                const parent = seenGroups[gid];
                parent.items.push(...(o.items || []));
                parent.totalPrice += o.totalPrice;
                if (o.deliveryPrice) parent.deliveryPrice = (parent.deliveryPrice || 0) + o.deliveryPrice;
                if (o.deliveryDistanceMeters) parent.deliveryDistanceMeters = Math.max(parent.deliveryDistanceMeters || 0, o.deliveryDistanceMeters);
                if (o.totalDeliveryPrice) parent.totalDeliveryPrice = (parent.totalDeliveryPrice || 0) + o.totalDeliveryPrice;
                if (o.totalDistanceKm) parent.totalDistanceKm = (parent.totalDistanceKm || 0) + o.totalDistanceKm;
                if (parent.status !== o.status && parent.status !== 'processing') {
                    parent.status = 'processing';
                }
                if (o.agentId && (!parent.involvedAgents || !parent.involvedAgents.includes(o.agentId))) {
                    if (!parent.involvedAgents) parent.involvedAgents = [];
                    parent.involvedAgents.push(o.agentId);
                }
                const subOrder = { ...o, items: [...(o.items || [])] };
                parent.subOrders.push(subOrder);
            }
        }
    }
    return displayOrders;
}

// ÔöÇÔöÇÔöÇ Controllers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

/**
 * @desc   Checkout ÔÇô create split store orders from the user's cart
 * @route  POST /api/store/orders/checkout
 *
 * Logic:
 *  1. Each cart item can carry its own deliveryLocation.
 *  2. Items are grouped by their primary agent (agentId on the Product).
 *  3. One StoreOrder is created per agent group ÔÇö each with a unique storeOrderId.
 *  4. All sub-orders share the same parentGroupId (UUID) so the representative
 *     can fetch the full order picture via GET /api/store/orders/group/:groupId.
 */
const checkout = async (req, res) => {
    const { error, value } = validateCreateStoreOrder(req.body);
    if (error) return res.status(400).json({ message: error.details.map(d => d.message).join(', ') });

    const userId = req.user.id;

    // Load cart
    const cart = await Cart.findOne({ userId }).populate('items.product');
    if (!cart || cart.items.length === 0) {
        return res.status(400).json({ message: 'Your cart is empty' });
    }

    // Validate all products are still active & in stock
    for (const item of cart.items) {
        const p = item.product;
        if (!p || !p.isActive) return res.status(400).json({ message: `Product "${p?.name}" is no longer available` });
        if (p.isSoldOut || p.stock < item.quantity) {
            return res.status(400).json({
                message: `"${p.name}" is sold out or has insufficient stock.`,
            });
        }
    }

    // Load user info
    const user = await User.findById(userId).select('firstName lastName email phone');

    // ÔöÇÔöÇ Batch-fetch association data for all cart products that have associationId ÔöÇÔöÇ
    const associationIds = [
        ...new Set(
            cart.items
                .map(i => i.product?.associationId?.toString())
                .filter(Boolean)
        )
    ];
    const associationMap = {};
    if (associationIds.length > 0) {
        const assocs = await Association.find(
            { _id: { $in: associationIds } },
            { name: 1, pickupLocation: 1 }
        );
        assocs.forEach(a => { associationMap[a._id.toString()] = a; });
    }

    // ÔöÇÔöÇ Build order items (snapshot prices, images, agent/association assignments) ÔöÇÔöÇ
    const orderItems = cart.items.map(item => {
        const p = item.product;
        const agentIds = p.agentId ? [p.agentId] : (p.assignedAgents || []);

        // Snapshot the first image at order time
        const firstImage =
            (Array.isArray(p.images) && p.images.length > 0)
                ? p.images[0]
                : (p.image || null);

        const productLocs = value.itemLocations.find(l => l.productId === p._id.toString()) || {};

        const itemDelivery = productLocs.deliveryLocation
            || ((item.deliveryLocation?.lat != null && item.deliveryLocation?.lng != null)
                ? { lat: item.deliveryLocation.lat, lng: item.deliveryLocation.lng, address: item.deliveryLocation.address || '' }
                : value.deliveryLocation);

        // ÔöÇÔöÇ Pickup location resolution ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
        // Priority: explicit itemLocations.pickupLocation ÔåÆ association pickup ÔåÆ product pickup
        let itemPickup = productLocs.pickupLocation || null;
        const assocId = p.associationId?.toString();
        if (!itemPickup) {
            if (assocId && associationMap[assocId]?.pickupLocation?.lat != null) {
                // Use association's pickup location
                const ap = associationMap[assocId].pickupLocation;
                itemPickup = { lat: ap.lat, lng: ap.lng, address: ap.address || '' };
            } else {
                itemPickup = { lat: null, lng: null, address: '' };
            }
        }

        const assocName = assocId ? (associationMap[assocId]?.name || null) : null;

        return {
            product: p._id,
            name: p.name,
            price: item.priceAtAdd,
            quantity: item.quantity,
            subtotal: item.priceAtAdd * item.quantity,
            productImage: firstImage,
            agentIds,
            associationId: assocId ? p.associationId : null,
            associationName: assocName,
            // Internal grouping helpers (stripped before saving)
            _primaryAgent: p.agentId || (p.assignedAgents?.[0]?.toString() || null),
            _primaryAgentName: p.agentName || null,
            _associationId: assocId || null,
            _associationName: assocName,
            deliveryLocation: itemDelivery,
            pickupLocation: itemPickup,
        };
    });

    // ÔöÇÔöÇ Group items by association first, then by agent ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    // Association products ÔåÆ grouped by associationId (key: 'assoc_<id>')
    // Regular agent products ÔåÆ grouped by agentId   (key: 'agent_<id>' or '__noAgent__')
    const agentGroups = {};
    for (const item of orderItems) {
        let key, groupMeta;
        if (item._associationId) {
            key = `assoc_${item._associationId}`;
            groupMeta = {
                agentId: null,
                agentName: null,
                associationId: item._associationId,
                associationName: item._associationName,
            };
        } else {
            key = item._primaryAgent ? `agent_${item._primaryAgent}` : '__noAgent__';
            groupMeta = {
                agentId: item._primaryAgent,
                agentName: item._primaryAgentName,
                associationId: null,
                associationName: null,
            };
        }
        if (!agentGroups[key]) {
            agentGroups[key] = { ...groupMeta, items: [] };
        }
        agentGroups[key].items.push(item);
    }

    // ÔöÇÔöÇ Deduct stock (once, before creating any orders) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    await deductStock(cart.items);

    // ÔöÇÔöÇ Shared group ID so the rep can fetch all sub-orders ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    const parentGroupId = randomUUID();

    const userInfo = {
        firstName: user?.firstName || '',
        lastName: user?.lastName || '',
        email: user?.email || '',
        phone: user?.phone || '',
        profileImage: user?.profileImage || null,
    };

    // ÔöÇÔöÇ Create one StoreOrder per group ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    const sharedStoreOrderId = await getNextStoreOrderId();
    const createdOrders = [];
    for (const group of Object.values(agentGroups)) {
        const groupItems = group.items.map(
            ({ _primaryAgent, _primaryAgentName, _associationId, _associationName, ...rest }) => rest
        );
        const involvedAgentsSet = new Set();
        groupItems.forEach(i => i.agentIds.forEach(id => involvedAgentsSet.add(id)));

        const groupTotal = groupItems.reduce((sum, i) => sum + i.subtotal, 0);

        const subOrder = new StoreOrder({
            storeOrderId: sharedStoreOrderId,
            parentGroupId,
            agentId: group.agentId,
            agentName: group.agentName,
            associationId: group.associationId || null,
            associationName: group.associationName || null,
            userId,
            userInfo,
            items: groupItems,
            totalPrice: groupTotal,
            deliveryPrice: value.deliveryPrice,
            deliveryDistanceMeters: value.deliveryDistanceMeters,
            notes: value.notes,
            paymentMethod: value.paymentMethod,
            deliveryLocation: value.deliveryLocation,   // checkout-level fallback
            involvedAgents: Array.from(involvedAgentsSet),
        });
        await subOrder.save();
        createdOrders.push(subOrder);
    }

    // ÔöÇÔöÇ Increment totalSold for each product ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    await Promise.all(
        orderItems.map(item =>
            Product.updateOne(
                { _id: item.product },
                { $inc: { totalSold: item.quantity } }
            )
        )
    );

    // ÔöÇÔöÇ Clear cart after successful checkout ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    await Cart.findOneAndDelete({ userId });

    res.status(201).json({
        message: 'Order placed successfully',
        parentGroupId,
        orderCount: createdOrders.length,
        orders: createdOrders,
    });
};


/**
 * @desc   Get current user's orders
 * @route  GET /api/store/orders/my
 */
const getMyOrders = async (req, res) => {
    const userId = req.user.id;
    const { page = 1, limit = 20, status } = req.query;

    const filter = { userId };
    if (status) filter.status = status;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [orders, total] = await Promise.all([
        StoreOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
        StoreOrder.countDocuments(filter),
    ]);

    // Enrich each order with product images (for old orders missing the snapshot)
    const enriched = await Promise.all(orders.map(o => enrichOrderImages(o)));

    res.json({
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        orders: enriched,
    });
};

/**
 * @desc   Get a specific order (owner or admin/agent/rep)
 * @route  GET /api/store/orders/:id
 */
const getOrderById = async (req, res) => {
    const idParam = req.params.id;
    const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(idParam);

    let order;
    if (isUuid) {
        const orders = await StoreOrder.find({ parentGroupId: idParam }).sort({ storeOrderId: 1 });
        if (!orders.length) return res.status(404).json({ message: 'Order not found' });
        const grouped = groupStoreOrders(orders);
        order = grouped[0];
    } else {
        if (!mongoose.Types.ObjectId.isValid(idParam)) {
            return res.status(400).json({ message: 'Invalid order ID format' });
        }
        order = await StoreOrder.findById(idParam);
        if (!order) return res.status(404).json({ message: 'Order not found' });
    }

    const userId = req.user.id;
    const isAdmin = req.user.isAdmin;
    const isAgent = req.user.userType === 'Agent';
    const isRepresentative = req.user.userType === 'Representative';

    if (isAdmin) {
        // Admin sees all
    } else if (isRepresentative) {
        // Representative sees all orders
    } else if (isAgent) {
        // Agent only sees order if they are involved
        if (!order.involvedAgents.includes(userId)) {
            return res.status(403).json({ message: 'Access denied. You are not assigned to products in this order.' });
        }
    } else {
        // Normal user only sees their own order
        if (order.userId !== userId) {
            return res.status(403).json({ message: 'Access denied' });
        }
    }

    const enriched = await enrichOrderImages(order);
    res.json(enriched);
};

/**
 * @desc   Get all sub-orders sharing the same parentGroupId (Representative / Admin)
 * @route  GET /api/store/orders/group/:groupId
 *
 * The representative uses this to see the full picture of a split checkout:
 * all sub-orders (one per agent), their items, delivery locations, statuses.
 */
const getOrdersByGroup = async (req, res) => {
    const { groupId } = req.params;

    const isAdmin = req.user.isAdmin;
    const isRepresentative = req.user.userType === 'Representative';
    const isAgent = req.user.userType === 'Agent';

    // Only admin, representative, or the owning user may call this
    const orders = await StoreOrder.find({ parentGroupId: groupId }).sort({ storeOrderId: 1 });
    if (!orders.length) return res.status(404).json({ message: 'No orders found for this group' });

    // Access control
    if (!isAdmin && !isRepresentative) {
        if (isAgent) {
            // Agent may only see it if they are involved in at least one sub-order
            const hasAccess = orders.some(o => o.involvedAgents.includes(req.user.id));
            if (!hasAccess) return res.status(403).json({ message: 'Access denied' });
        } else {
            // Normal user may only see their own group
            const isOwner = orders.every(o => o.userId === req.user.id);
            if (!isOwner) return res.status(403).json({ message: 'Access denied' });
        }
    }

    const enriched = await Promise.all(orders.map(o => enrichOrderImages(o)));

    res.json({
        parentGroupId: groupId,
        orderCount: enriched.length,
        totalPrice: enriched.reduce((s, o) => s + o.totalPrice, 0),
        orders: enriched,
    });
};

/**
 * @desc   Admin/Agent: Get all store orders
 * @route  GET /api/store/orders
 * @query  page, limit, status, userId, search,
 *         date      (YYYY-MM-DD)  ÔÇö exact calendar day filter
 *         dateFrom  (YYYY-MM-DD)  ÔÇö range start (inclusive)
 *         dateTo    (YYYY-MM-DD)  ÔÇö range end   (inclusive)
 *         agentId   ÔÇö filter sub-orders by a specific agent
 *         groupId   ÔÇö filter by parentGroupId
 */
const getAllOrders = async (req, res) => {
    const {
        page = 1,
        limit = 20,
        status,
        userId: filterUserId,
        search,
        date,       // exact day  e.g. "2026-05-10"
        dateFrom,   // range start
        dateTo,     // range end
        agentId,    // filter by specific agent
        groupId,    // filter by parentGroupId
    } = req.query;

    const isAdmin = req.user?.isAdmin;
    const isAgent = req.user?.userType === 'Agent';

    const filter = {};
    if (status) filter.status = status;
    if (filterUserId) filter.userId = filterUserId;
    if (groupId) filter.parentGroupId = groupId;

    if (agentId) {
        filter.agentId = agentId;
    } else if (isAgent && !isAdmin) {
        // Agent only sees their own sub-orders
        filter.agentId = req.user.id;
    }

    if (search) {
        filter.$or = [
            { 'userInfo.firstName': { $regex: search, $options: 'i' } },
            { 'userInfo.lastName': { $regex: search, $options: 'i' } },
            { 'userInfo.email': { $regex: search, $options: 'i' } },
            { 'items.name': { $regex: search, $options: 'i' } },
        ];
    }

    // ÔöÇÔöÇ Date filtering ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    if (date) {
        const dayStart = new Date(date);
        dayStart.setUTCHours(0, 0, 0, 0);
        const dayEnd = new Date(date);
        dayEnd.setUTCHours(23, 59, 59, 999);
        if (!isNaN(dayStart)) filter.createdAt = { $gte: dayStart, $lte: dayEnd };
    } else if (dateFrom || dateTo) {
        filter.createdAt = {};
        if (dateFrom) {
            const from = new Date(dateFrom);
            from.setUTCHours(0, 0, 0, 0);
            if (!isNaN(from)) filter.createdAt.$gte = from;
        }
        if (dateTo) {
            const to = new Date(dateTo);
            to.setUTCHours(23, 59, 59, 999);
            if (!isNaN(to)) filter.createdAt.$lte = to;
        }
        if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
    }
    // ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [orders, total, revenueResult] = await Promise.all([
        StoreOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
        StoreOrder.countDocuments(filter),
        StoreOrder.aggregate([
            { $match: filter },
            { $group: { _id: null, totalRevenue: { $sum: '$totalPrice' } } }
        ])
    ]);
    const totalRevenue = revenueResult[0]?.totalRevenue || 0;

    // Grouping for Admin ONLY, if no specific agent filter is applied
    let displayOrders = [];
    if (isAdmin && !agentId && !groupId) {
        displayOrders = groupStoreOrders(orders);
    } else {
        displayOrders = orders;
    }

    // Enrich each order with product images
    const enriched = await Promise.all(displayOrders.map(o => enrichOrderImages(o)));

    res.json({
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        totalRevenue,
        dateFilter: date || (dateFrom || dateTo ? { from: dateFrom, to: dateTo } : null),
        orders: enriched,
    });
};

/**
 * @desc   Admin/Agent: Update order status
 * @route  PATCH /api/store/orders/:id/status
 */
const updateOrderStatus = async (req, res) => {
    const { error, value } = validateUpdateStoreOrderStatus(req.body);
    if (error) return res.status(400).json({ message: error.details[0].message });

    const idParam = req.params.id;
    const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(idParam);

    const isAdmin = req.user?.isAdmin;
    const isAgent = req.user?.userType === 'Agent';

    if (isUuid) {
        if (isAgent && !isAdmin) {
             return res.status(403).json({ message: 'Access denied. Agents cannot update grouped orders directly.' });
        }
        const orders = await StoreOrder.find({ parentGroupId: idParam });
        if (!orders.length) return res.status(404).json({ message: 'Order group not found' });
        
        for (const order of orders) {
            order.status = value.status;
            await order.save();
        }
        return res.json({
            message: 'Group order status updated',
            storeOrderId: orders[0].storeOrderId,
            status: value.status,
            updatedAt: orders[0].updatedAt,
        });
    }

    if (!mongoose.Types.ObjectId.isValid(idParam)) {
        return res.status(400).json({ message: 'Invalid order ID format' });
    }

    const order = await StoreOrder.findById(idParam);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (isAgent && !isAdmin) {
        // Agent can only update their own sub-order
        if (order.agentId !== req.user.id && !order.involvedAgents.includes(req.user.id)) {
            return res.status(403).json({ message: 'Access denied. You are not assigned to this order.' });
        }
    }

    order.status = value.status;
    await order.save();

    res.json({
        message: 'Order status updated',
        storeOrderId: order.storeOrderId,
        status: order.status,
        updatedAt: order.updatedAt,
    });
};

/**
 * @desc   Client: Cancel own order (only if pending)
 * @route  PATCH /api/store/orders/:id/cancel
 */
const cancelOrder = async (req, res) => {
    const userId = req.user.id;
    const order = await StoreOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.userId !== userId) return res.status(403).json({ message: 'Access denied' });
    if (order.status !== 'pending') {
        return res.status(400).json({ message: `Cannot cancel an order with status: ${order.status}` });
    }

    order.status = 'cancelled';
    await order.save();

    res.json({ message: 'Order cancelled', storeOrderId: order.storeOrderId, status: order.status });
};

/**
 * @desc   Client: Cancel all pending sub-orders in a group
 * @route  PATCH /api/store/orders/group/:groupId/cancel
 */
const cancelOrderGroup = async (req, res) => {
    const userId = req.user.id;
    const { groupId } = req.params;

    const orders = await StoreOrder.find({ parentGroupId: groupId, userId });
    if (!orders.length) return res.status(404).json({ message: 'No orders found for this group' });

    const nonPending = orders.filter(o => o.status !== 'pending');
    if (nonPending.length > 0) {
        return res.status(400).json({
            message: `Cannot cancel: ${nonPending.length} sub-order(s) are already past pending status.`,
        });
    }

    await StoreOrder.updateMany({ parentGroupId: groupId, userId }, { $set: { status: 'cancelled' } });

    res.json({ message: 'All sub-orders cancelled', parentGroupId: groupId, cancelledCount: orders.length });
};

/**
 * @desc   Set delivery location for a specific item in a cart
 * @route  PATCH /api/store/cart/:productId/delivery-location
 */

// ÔöÇÔöÇÔöÇ Representative Controllers ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

/**
 * @desc   Representative: List all pending store orders (available to pick up)
 * @route  GET /api/store/orders/representative/pending
 * @query  status (optional, comma-separated: pending,confirmed,processing,shipped,delivered,cancelled)
 * @access Representative / Admin
 */
const getRepresentativeOrders = async (req, res) => {
    try {
        const { status, page = 1, limit = 50 } = req.query;

        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const skip = (pageNum - 1) * limitNum;

        const filter = {};
        if (status) {
            const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
            filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
        } else {
            // Default: show pending orders (unassigned)
            filter.status = 'pending';
        }

        const [orders, total] = await Promise.all([
            StoreOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
            StoreOrder.countDocuments(filter),
        ]);

        const grouped = groupStoreOrders(orders);
        const enriched = await Promise.all(grouped.map(o => enrichOrder(o)));

        res.json({
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.ceil(total / limitNum),
            orders: enriched,
        });
    } catch (err) {
        console.error('[getRepresentativeOrders]', err.message);
        res.status(500).json({ message: 'Internal server error' });
    }
};

/**
 * @desc   Representative: Get my accepted orders
 * @route  GET /api/store/orders/representative/my
 * @query  status (optional)
 * @access Representative
 */
const getRepresentativeMyOrders = async (req, res) => {
    try {
        const repId = req.user.id;
        const { status, page = 1, limit = 50 } = req.query;

        const pageNum  = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const skip = (pageNum - 1) * limitNum;

        const filter = { representativeId: repId };
        if (status) {
            const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
            filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
        }

        const [orders, total] = await Promise.all([
            StoreOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
            StoreOrder.countDocuments(filter),
        ]);

        const grouped = groupStoreOrders(orders);
        const enriched = await Promise.all(grouped.map(o => enrichOrder(o)));

        res.json({
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.ceil(total / limitNum),
            orders: enriched,
        });
    } catch (err) {
        console.error('[getRepresentativeMyOrders]', err.message);
        res.status(500).json({ message: 'Internal server error' });
    }
};

/**
 * @desc   Representative: Accept a pending store order
 * @route  PATCH /api/store/orders/:id/accept
 * @body   {} (empty ÔÇö representativeId taken from JWT)
 * @access Representative
 */
const acceptStoreOrder = async (req, res) => {
    try {
        const { id } = req.params;
        const repId = req.user.id;

        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);

        let ordersToUpdate = [];
        if (isUuid) {
            ordersToUpdate = await StoreOrder.find({ parentGroupId: id });
        } else {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ message: 'Invalid order ID format' });
            }
            const o = await StoreOrder.findById(id);
            if (o) ordersToUpdate.push(o);
        }

        if (!ordersToUpdate.length) return res.status(404).json({ message: 'Order not found' });

        if (ordersToUpdate.some(o => o.status !== 'pending')) {
            return res.status(409).json({
                message: `Cannot accept order. Some orders are not pending.`,
            });
        }

        for (const order of ordersToUpdate) {
            order.status = 'confirmed';
            order.representativeId = repId;
            await order.save();
        }

        const grouped = groupStoreOrders(ordersToUpdate);
        const order = grouped[0];
        const enriched = await enrichOrder(order);

        // ÔöÇÔöÇÔöÇ FCM: notify client that order is confirmed ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
        notifyClient(
            order.userId,
            '­ƒôª Ï¬┘à Ï¬Ïú┘â┘èÏ» ÏÀ┘äÏ¿┘â',
            'Ï¬┘à ┘éÏ¿┘ê┘ä ÏÀ┘äÏ¿┘â ┘à┘å ┘é┘ÉÏ¿┘Ä┘ä Ïº┘ä┘à┘åÏ»┘êÏ¿ ┘êÏ│┘èÏ¬┘à Ï¬Ï¼┘ç┘èÏ▓┘ç ┘éÏ▒┘èÏ¿Ïº┘ï',
            { type: 'store_order_confirmed', storeOrderId: String(order.storeOrderId), orderId: String(order._id) },
        ).catch(() => {});

        res.json({
            succeeded: true,
            message: 'Order accepted successfully',
            ...enriched,
        });
    } catch (err) {
        console.error('[acceptStoreOrder]', err.message);
        res.status(500).json({ message: 'Internal server error' });
    }
};

/**
 * @desc   Representative: Release an accepted store order back to pending
 * @route  PATCH /api/store/orders/:id/release
 * @body   { reason: 'string' } (optional)
 * @access Representative
 */
const releaseStoreOrder = async (req, res) => {
    try {
        const { id } = req.params;
        const repId = req.user.id;
        const isAdmin = req.user.role === 'Admin';
        const reason = req.body.reason || 'Ïº┘ä┘à┘åÏ»┘êÏ¿ Ïú┘äÏ║┘ë Ïº┘ä┘à┘ç┘àÏ®';

        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);

        let ordersToUpdate = [];
        if (isUuid) {
            ordersToUpdate = await StoreOrder.find({ parentGroupId: id });
        } else {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ message: 'Invalid order ID format' });
            }
            const o = await StoreOrder.findById(id);
            if (o) ordersToUpdate.push(o);
        }

        if (!ordersToUpdate.length) return res.status(404).json({ message: 'Order not found' });

        for (const order of ordersToUpdate) {
            // Security: representative can only release their own accepted orders
            if (!isAdmin && order.representativeId !== repId) {
                return res.status(403).json({
                    message: 'Access denied. You are not assigned to this order.',
                });
            }
            
            // Allow releasing if not fully delivered/cancelled
            if (order.status === 'delivered' || order.status === 'cancelled') {
                return res.status(409).json({
                    message: `Cannot release order with status: ${order.status}`,
                });
            }

            order.status = 'pending';
            order.representativeId = null;
            await order.save();
        }

        const grouped = groupStoreOrders(ordersToUpdate);
        const order = grouped[0];
        const enriched = await enrichOrder(order);

        // ­ƒöö FCM: notify client that order is returned to pending (searching for representative)
        notifyClient(
            order.userId,
            'Ï¼ÏºÏ▒┘è Ïº┘äÏ¿Ï¡Ï½ Ï╣┘å ┘à┘åÏ»┘êÏ¿ Ï¼Ï»┘èÏ»',
            'Ï¬┘à ÏÑ┘äÏ║ÏºÏí Ï¬Ï╣┘è┘è┘å Ïº┘ä┘à┘åÏ»┘êÏ¿ ┘êÏ¼ÏºÏ▒┘è ÏÑÏ│┘åÏºÏ» Ïº┘äÏÀ┘äÏ¿ ┘ä┘à┘åÏ»┘êÏ¿ ÏóÏ«Ï▒',
            { type: 'store_order_released', storeOrderId: String(order.storeOrderId), orderId: String(order._id) },
        ).catch(() => {});

        res.json({
            succeeded: true,
            message: 'Order released back to pending successfully',
            ...enriched,
        });
    } catch (err) {
        console.error('[releaseStoreOrder]', err.message);
        res.status(500).json({ message: 'Internal server error' });
    }
};

/**
 * @desc   Representative: Update store order status
 *         Allowed transitions: confirmed ÔåÆ processing ÔåÆ shipped ÔåÆ delivered
 *         Sends FCM notifications at key milestones.
 * @route  PATCH /api/store/orders/:id/representative-status
 * @body   { status: 'processing' | 'shipped' | 'delivered' | 'cancelled' }
 * @access Representative
 */
const updateRepresentativeStoreOrderStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const repId = req.user.id;
        const { status } = req.body;

        const ALLOWED_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled'];
        if (!status || !ALLOWED_STATUSES.includes(status)) {
            return res.status(400).json({
                message: `status must be one of: ${ALLOWED_STATUSES.join(', ')}`,
            });
        }

        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);

        let ordersToUpdate = [];
        if (isUuid) {
            ordersToUpdate = await StoreOrder.find({ parentGroupId: id });
        } else {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ message: 'Invalid order ID format' });
            }
            const o = await StoreOrder.findById(id);
            if (o) ordersToUpdate.push(o);
        }

        if (!ordersToUpdate.length) return res.status(404).json({ message: 'Order not found' });

        const isAdmin = req.user?.isAdmin;

        for (const order of ordersToUpdate) {
            // Security: representative can only update their own accepted orders
            if (!isAdmin && order.representativeId !== repId) {
                return res.status(403).json({
                    message: 'Access denied. You are not assigned to this order.',
                });
            }

            // Valid transitions from current status
            const VALID_TRANSITIONS = {
                confirmed:  ['processing', 'shipped', 'cancelled'],
                processing: ['shipped', 'cancelled'],
                shipped:    ['delivered', 'cancelled'],
            };

            if (order.status === status) {
                // Already in this state, consider it a success for idempotency
                continue;
            }

            const allowed = VALID_TRANSITIONS[order.status];
            if (!allowed || !allowed.includes(status)) {
                return res.status(409).json({
                    message: `Cannot transition from '${order.status}' to '${status}'.`,
                    currentStatus: order.status,
                    allowedNext: allowed || [],
                });
            }

            order.status = status;
            await order.save();

            // ÔöÇÔöÇÔöÇ FCM Notifications PER SUB-ORDER ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
            const agentStr = order.agentName ? ` ┘à┘å ┘é┘ÉÏ¿┘ä ${order.agentName}` : '';
            if (status === 'shipped') {
                notifyClient(
                    order.userId,
                    '­ƒÜÜ Ï¬Ï¡Ï»┘èÏ½ Ï¡Ïº┘äÏ® Ïº┘äÏÀ┘äÏ¿',
                    'Ï¬┘à ÏºÏ│Ï¬┘äÏº┘à Ïº┘äÏ┤Ï¡┘å┘ç ┘à┘å ┘éÏ¿┘ä Ïº┘ä┘à┘åÏ»┘êÏ¿ ┘êÏ│┘èÏ¬┘à Ïº┘äÏ¬┘êÏºÏÁ┘ä Ï¿┘â',
                    { type: 'store_order_shipped', storeOrderId: String(order.storeOrderId), orderId: String(order._id) }
                ).catch(() => {});
            } else if (status === 'delivered') {
                notifyClient(
                    order.userId,
                    'Ô£à Ï¬Ï¡Ï»┘èÏ½ Ï¡Ïº┘äÏ® Ïº┘äÏÀ┘äÏ¿',
                    'Ï¬┘à Ï¬Ï│┘ä┘è┘à Ïº┘äÏº┘êÏ▒Ï»Ï▒ Ï¿┘åÏ¼ÏºÏ¡',
                    { type: 'store_order_delivered', storeOrderId: String(order.storeOrderId), orderId: String(order._id) }
                ).catch(() => {});
            } else if (status === 'cancelled') {
                notifyClient(
                    order.userId,
                    'ÔØî Ï¬┘à ÏÑ┘äÏ║ÏºÏí Ï¼Ï▓Ïí ┘à┘å ÏÀ┘äÏ¿┘â',
                    `Ï¬┘à ÏÑ┘äÏ║ÏºÏí ÏÀ┘äÏ¿┘â${agentStr} ┘à┘å ┘é┘ÉÏ¿┘Ä┘ä Ïº┘ä┘à┘åÏ»┘êÏ¿`,
                    { type: 'store_order_cancelled', storeOrderId: String(order.storeOrderId), orderId: String(order._id) }
                ).catch(() => {});
            } else if (status === 'processing') {
                notifyClient(
                    order.userId,
                    'ÔÅ│ Ï¼ÏºÏ▒┘è Ï¬Ï¼┘ç┘èÏ▓ Ï¼Ï▓Ïí ┘à┘å ÏÀ┘äÏ¿┘â',
                    `Ïº┘ä┘à┘åÏ»┘êÏ¿ ┘èÏ¬Ï¼┘ç ┘äÏºÏ│Ï¬┘äÏº┘à ÏÀ┘äÏ¿┘â${agentStr}`,
                    { type: 'store_order_processing', storeOrderId: String(order.storeOrderId), orderId: String(order._id) }
                ).catch(() => {});
            }
        }

        // Fetch the full updated group to return
        const parentGroupId = ordersToUpdate[0].parentGroupId;
        const fullGroupOrders = await StoreOrder.find({ parentGroupId });
        const enrichedList = await Promise.all(fullGroupOrders.map(o => enrichOrder(o)));
        const grouped = groupStoreOrders(enrichedList);

        res.json({
            succeeded: true,
            message: `Order status updated to '${status}'`,
            ...grouped[0],
        });
    } catch (err) {
        console.error('[updateRepresentativeStoreOrderStatus]', err.message);
        res.status(500).json({ message: 'Internal server error' });
    }
};

/**
 * @desc   Upload pickup or delivery photo for a StoreOrder group
 * @route  POST /api/store/orders/:id/photo/:stage  (stage = pickup | delivery)
 */
const uploadPhotoHandler = upload.single('photo');
const uploadStoreOrderPhoto = [
    (req, res, next) => uploadPhotoHandler(req, res, next),
    async (req, res) => {
        try {
            const { id, stage } = req.params;
            if (!req.file) {
                return res.status(400).json({ message: 'photo file is required' });
            }
            if (stage !== 'pickup' && stage !== 'delivery') {
                return res.status(400).json({ message: 'stage must be pickup or delivery' });
            }

            const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
            let ordersToUpdate = [];
            if (isUuid) {
                ordersToUpdate = await StoreOrder.find({ parentGroupId: id });
            } else {
                const o = await StoreOrder.findById(id);
                if (o) ordersToUpdate.push(o);
            }

            if (!ordersToUpdate.length) return res.status(404).json({ message: 'Order not found' });

            const photoUrl = req.file.path;
            for (const order of ordersToUpdate) {
                if (stage === 'pickup') {
                    order.pickupPhoto = photoUrl;
                } else {
                    order.deliveryPhoto = photoUrl;
                }
                await order.save();
            }

            res.status(200).json({
                succeeded: true,
                message: `Photo uploaded successfully for stage ${stage}`,
                photoUrl,
            });
        } catch (err) {
            console.error('[uploadStoreOrderPhoto]', err.message);
            res.status(500).json({ message: 'Internal server error' });
        }
    }
];

module.exports = {
    checkout,
    getMyOrders,
    getOrderById,
    getOrdersByGroup,
    getAllOrders,
    updateOrderStatus,
    cancelOrder,
    cancelOrderGroup,
    // ÔöÇÔöÇÔöÇ Representative ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
    getRepresentativeOrders,
    getRepresentativeMyOrders,
    acceptStoreOrder,
    releaseStoreOrder,
    updateRepresentativeStoreOrderStatus,
    uploadStoreOrderPhoto,
};

