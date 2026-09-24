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
const { Restaurant } = require('../middlewares/Restaurant');
const { notifyClient } = require('../services/notifyClient');
const { buildUrl } = require('../config/urlBuilder');
const { getCachedRepCommission, calcRepEarnings } = require('../middlewares/RepCommission');
const { checkAndRewardTarget } = require('../utils/targetRewardHelper');
const { BusinessOrderTracker } = require('../services/BusinessOrderTracker');
const {
    deductProductStockAtomically,
    restoreProductStockAtomically,
    supportsTransactions,
} = require('../services/inventoryService');

// ─── Multer Setup ────────────────────────────────────────────────────────────
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

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Resolves one or more StoreOrder documents given an ID that may be:
 * 1. A UUID (parentGroupId)
 * 2. A 24-hex MongoDB ObjectId (_id)
 * 3. A positive integer / numeric string (storeOrderId or orderId)
 *
 * @param {string|number} id
 * @param {boolean} [expandGroup=true] If true and an order belongs to a parentGroupId, returns all sub-orders in the group
 * @returns {Promise<Array>} Array of matching StoreOrder documents
 */
async function findStoreOrdersByIdentifier(id, expandGroup = true) {
    if (!id) return [];
    const strId = String(id).trim();

    const isStoreOrderCriteria = {
        $or: [
            { isBusinessOrder: true },
            { orderCategory: 'business' },
            { parentGroupId: { $ne: null } },
            { items: { $exists: true, $not: { $size: 0 } } },
        ]
    };

    // 1. UUID -> parentGroupId
    const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(strId);
    if (isUuid) {
        return await StoreOrder.find({ parentGroupId: strId });
    }

    // 2. ObjectId -> find by _id
    if (mongoose.Types.ObjectId.isValid(strId)) {
        const o = await StoreOrder.findOne({
            _id: strId,
            ...isStoreOrderCriteria
        });
        if (o) {
            if (expandGroup && o.parentGroupId) {
                return await StoreOrder.find({ parentGroupId: o.parentGroupId });
            }
            return [o];
        }
    }

    // 3. Numeric ID -> find by storeOrderId or orderId
    if (!isNaN(Number(strId))) {
        const numId = Number(strId);
        const orders = await StoreOrder.find({
            $and: [
                isStoreOrderCriteria,
                {
                    $or: [
                        { storeOrderId: numId },
                        { orderId: numId },
                    ]
                }
            ]
        });
        if (orders.length > 0) {
            if (expandGroup) {
                const firstWithGroup = orders.find(o => o.parentGroupId);
                if (firstWithGroup) {
                    return await StoreOrder.find({ parentGroupId: firstWithGroup.parentGroupId });
                }
            }
            return orders;
        }
    }

    return [];
}

/**
 * Helper: Enriches a StoreOrder object with first product image + pickupLocation
 * deliveryLocation is already stored on the order itself (set at checkout).
 */
async function enrichOrder(param1, param2) {
    let req = null;
    let order = null;

    const isExpressReq = (p) => Boolean(
        p && (
            p.headers ||
            p.rawHeaders ||
            (p.method && p.url) ||
            (p.app && p.baseUrl !== undefined) ||
            (typeof p.get === 'function' && !p.$__ && !p._doc && !p.schema && !p.isNew && !p.save)
        )
    );

    if (isExpressReq(param1)) {
        req = param1;
        order = param2;
    } else if (isExpressReq(param2)) {
        req = param2;
        order = param1;
    } else {
        order = param1;
        req = param2;
    }

    if (!order) return null;

    function safeUrl(img) {
        if (!img) return null;
        if (typeof img !== 'string') return null;
        if (img.startsWith('http://') || img.startsWith('https://')) return img;
        if (req) {
            try {
                return buildUrl(req, img);
            } catch (_) { }
        }
        if (process.env.HOST) {
            const base = process.env.HOST.replace(/\/$/, '');
            return `${base}/uploads/${img}`;
        }
        return `https://mashawerr-api.onrender.com/uploads/${img}`;
    }

    const obj = order.toObject ? order.toObject() : { ...order };

    // ─── أسعار وأرباح المندوب لطلبات البيزنيس (بالفلس الصحيح لغاية فلس واحد) ─────────────────────────
    let dPrice = obj.deliveryPrice != null ? Math.round(Number(obj.deliveryPrice)) : 0;
    let tPrice = obj.totalPrice != null ? Math.round(Number(obj.totalPrice)) : 0;
    obj.totalPrice = tPrice;

    const commissionCfg = await getCachedRepCommission().catch(() => null);
    const businessPct = commissionCfg?.businessRepCommissionPct ?? 100;
    const repEarnings = Math.round((dPrice * businessPct) / 100);
    obj.repEarnings = repEarnings;
    obj.businessRepCommissionPct = businessPct;
    obj.totalDeliveryPrice = dPrice;
    obj.deliveryPrice = dPrice;

    // Collect all unique product IDs from order items
    const rawItems = Array.isArray(obj.items) ? obj.items : [];
    const productIds = rawItems
        .map(i => i.product?.toString())
        .filter(Boolean);

    // One batch query — fetch image + pickupLocation for all products
    let productMap = {};
    if (productIds.length > 0 && mongoose.connection.readyState === 1) {
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

    // ─── Resolve real Agent / Store names across order, subOrders, items & tasks ───
    const isHexObjectId = (str) => typeof str === 'string' && /^[0-9a-fA-F]{24}$/.test(str.trim());
    const initialSubs = Array.isArray(obj.subOrders) ? obj.subOrders : [];
    const agentIdCandidates = new Set();

    if (isHexObjectId(obj.agentId)) agentIdCandidates.add(obj.agentId.trim());
    if (isHexObjectId(obj.agentName)) agentIdCandidates.add(obj.agentName.trim());

    initialSubs.forEach(s => {
        if (isHexObjectId(s.agentId)) agentIdCandidates.add(s.agentId.trim());
        if (isHexObjectId(s.agentName)) agentIdCandidates.add(s.agentName.trim());
    });

    rawItems.forEach(item => {
        if (isHexObjectId(item.agentId)) agentIdCandidates.add(item.agentId.trim());
        if (isHexObjectId(item.agentName)) agentIdCandidates.add(item.agentName.trim());
        if (Array.isArray(item.agentIds)) {
            item.agentIds.forEach(id => {
                if (isHexObjectId(id)) agentIdCandidates.add(id.trim());
            });
        }
    });

    if (Array.isArray(obj.tasks)) {
        obj.tasks.forEach(t => {
            if (isHexObjectId(t.agentId)) agentIdCandidates.add(t.agentId.trim());
            if (isHexObjectId(t.agentName)) agentIdCandidates.add(t.agentName.trim());
        });
    }

    let agentMap = {};
    if (agentIdCandidates.size > 0 && mongoose.connection.readyState === 1) {
        try {
            const agentDocs = await User.find(
                { _id: { $in: Array.from(agentIdCandidates) } },
                { firstName: 1, lastName: 1, phone: 1, storeName: 1, fullName: 1 }
            ).lean();

            agentDocs.forEach(a => {
                const realName = (a.storeName && a.storeName.trim()) ||
                    `${a.firstName || ''} ${a.lastName || ''}`.trim() ||
                    (a.fullName && a.fullName.trim()) ||
                    null;
                if (realName) {
                    agentMap[a._id.toString()] = {
                        id: a._id.toString(),
                        name: realName,
                        storeName: a.storeName || realName,
                        phone: a.phone || '',
                    };
                }
            });
        } catch (_) { /* non-critical */ }
    }

    function resolveRealAgentName(id, currentName) {
        if (id && agentMap[id.toString()]) {
            return agentMap[id.toString()].name;
        }
        if (isHexObjectId(currentName) && agentMap[currentName]) {
            return agentMap[currentName].name;
        }
        if (currentName && !isHexObjectId(currentName) && currentName !== 'null') {
            return currentName;
        }
        return null;
    }

    const resolvedRootAgentName = resolveRealAgentName(obj.agentId, obj.agentName);
    if (resolvedRootAgentName) {
        obj.agentName = resolvedRootAgentName;
        obj.storeName = resolvedRootAgentName;
    }

    obj.items = rawItems.map(item => {
        const pid = item.product?.toString();
        const productData = productMap[pid] || {};

        const itemPickup = (item.pickupLocation && item.pickupLocation.lat != null)
            ? item.pickupLocation
            : (productData.pickupLocation || null);

        let pPrice = item.price != null ? Number(item.price) : 0;
        pPrice = Number(pPrice.toFixed(3));

        let pSubtotal = item.subtotal != null ? Number(item.subtotal) : (pPrice * (item.quantity || 1));
        pSubtotal = Number(pSubtotal.toFixed(3));

        const itemAgentId = item.agentId || (item.agentIds && item.agentIds[0]) || obj.agentId || null;
        const itemAgentName = resolveRealAgentName(itemAgentId, item.agentName) || resolvedRootAgentName;

        return {
            ...item,
            price: pPrice,
            subtotal: pSubtotal,
            productImage: item.productImage || productData.image || null,
            pickupLocation: itemPickup,
            agentId: itemAgentId,
            agentName: itemAgentName,
            storeName: itemAgentName,
        };
    });

    if (obj.subOrders && obj.subOrders.length > 0) {
        obj.subOrders = obj.subOrders.map(sub => {
            const resolvedSubAgentName = resolveRealAgentName(sub.agentId, sub.agentName) || resolvedRootAgentName;
            if (resolvedSubAgentName) {
                sub.agentName = resolvedSubAgentName;
                sub.storeName = resolvedSubAgentName;
            }
            if (sub.items) {
                sub.items = sub.items.map(item => {
                    const pid = item.product?.toString();
                    const productData = productMap[pid] || {};
                    const itemPickup = (item.pickupLocation && item.pickupLocation.lat != null)
                        ? item.pickupLocation
                        : (productData.pickupLocation || null);
                    const itemAgentId = item.agentId || (item.agentIds && item.agentIds[0]) || sub.agentId || obj.agentId || null;
                    const itemAgentName = resolveRealAgentName(itemAgentId, item.agentName) || resolvedSubAgentName;
                    return {
                        ...item,
                        productImage: item.productImage || productData.image || null,
                        pickupLocation: itemPickup,
                        agentId: itemAgentId,
                        agentName: itemAgentName,
                        storeName: itemAgentName,
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

    // Enrich userInfo with latest customer details (name, phone, profileImage) if missing or incomplete
    if (obj.userId && mongoose.connection.readyState === 1) {
        try {
            const customer = await User.findById(obj.userId, { firstName: 1, lastName: 1, phone: 1, profileImage: 1 });
            if (customer) {
                if (!obj.userInfo) obj.userInfo = {};
                if (!obj.userInfo.firstName && customer.firstName) obj.userInfo.firstName = customer.firstName;
                if (!obj.userInfo.lastName && customer.lastName) obj.userInfo.lastName = customer.lastName;
                if (!obj.userInfo.phone && customer.phone) obj.userInfo.phone = customer.phone;
                if (!obj.userInfo.profileImage && customer.profileImage) obj.userInfo.profileImage = customer.profileImage;
            }
        } catch (_) { /* non-critical */ }
    }

    // ─── Direct normalized fields for UI consistency ───────────────────────────
    const cFirstName = obj.userInfo?.firstName || '';
    const cLastName = obj.userInfo?.lastName || '';
    const fullClientName = `${cFirstName} ${cLastName}`.trim() || 'عميل';
    obj.clientName = (fullClientName && fullClientName !== 'عميل') ? fullClientName : (obj.clientName || 'عميل');
    obj.clientPhoneNumber = obj.userInfo?.phone || obj.clientPhoneNumber || null;
    obj.clientPhotoUrl = safeUrl(obj.userInfo?.profileImage) || obj.clientPhotoUrl || null;
    obj.storeOrderId = obj.storeOrderId || obj.orderId || null;
    obj.orderId = obj.storeOrderId || obj.orderId || (obj._id ? obj._id.toString() : null);
    obj.id = String(obj.storeOrderId || obj.orderId || obj._id || '');
    obj.isStoreOrder = true;

    // Proof of Pickup & Proof of Delivery Photos Resolution with Group Fallback
    const allSubs = Array.isArray(obj.subOrders) ? obj.subOrders : [];

    // ─── PoD V2 DeliverySession & DeliveryAttempt Fallback ─────────────────────
    const podPickupList = [];
    const podDeliveryList = [];

    try {
        const { DeliveryAttempt } = require('../models/DeliveryAttempt');
        const { DeliverySession } = require('../models/DeliverySession');

        const idsToQuery = [
            obj._id,
            obj._id ? obj._id.toString() : null,
            obj.storeOrderId,
            obj.storeOrderId ? String(obj.storeOrderId) : null,
            !isNaN(Number(obj.storeOrderId)) ? Number(obj.storeOrderId) : null,
            obj.orderId,
            obj.orderId ? String(obj.orderId) : null,
            !isNaN(Number(obj.orderId)) ? Number(obj.orderId) : null,
            obj.parentGroupId,
            obj.activeDeliverySessionId,
            obj.deliverySessionId,
            ...allSubs.flatMap(s => [
                s._id,
                s._id ? s._id.toString() : null,
                s.storeOrderId,
                s.storeOrderId ? String(s.storeOrderId) : null,
                !isNaN(Number(s.storeOrderId)) ? Number(s.storeOrderId) : null,
                s.orderId,
                s.orderId ? String(s.orderId) : null,
                !isNaN(Number(s.orderId)) ? Number(s.orderId) : null,
                s.activeDeliverySessionId,
                s.deliverySessionId
            ])
        ].filter(Boolean);

        if (idsToQuery.length > 0 && mongoose.connection.readyState === 1) {
            const sessions = await DeliverySession.find({
                $or: [
                    { orderId: { $in: idsToQuery } },
                    { sessionId: { $in: idsToQuery } }
                ]
            }).lean();

            if (sessions.length > 0) {
                const sessionIds = sessions.map(s => s.sessionId).filter(Boolean);
                const attempts = await DeliveryAttempt.find({
                    $or: [
                        { sessionId: { $in: sessionIds } },
                        { orderId: { $in: idsToQuery } }
                    ]
                })
                    .sort({ createdAt: 1, attemptNumber: 1 })
                    .lean();

                for (const a of attempts) {
                    let photoUrl = null;
                    if (a.photo?.cdnUrl) {
                        photoUrl = a.photo.cdnUrl;
                    } else if (a.photo?.objectKey) {
                        photoUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0'}/image/upload/${a.photo.objectKey}`;
                    } else if (a.photoUrl) {
                        photoUrl = safeUrl(a.photoUrl);
                    } else if (a.photo && typeof a.photo === 'string') {
                        photoUrl = safeUrl(a.photo);
                    } else if (a.image && typeof a.image === 'string') {
                        photoUrl = safeUrl(a.image);
                    }

                    if (photoUrl) {
                        photoUrl = safeUrl(photoUrl);
                        if (a.phase === 'PICKUP') {
                            if (!podPickupList.includes(photoUrl)) podPickupList.push(photoUrl);
                        } else {
                            if (!podDeliveryList.includes(photoUrl)) podDeliveryList.push(photoUrl);
                        }
                    }
                }
            }
        }
    } catch (_) { /* non-critical fallback */ }

    const podPickupPhoto = podPickupList[0] || null;
    const podDeliveryPhoto = podDeliveryList[0] || null;

    const rootPickup = safeUrl(obj.pickupPhoto || obj.itemPhotoBefore) ||
        allSubs.map(s => safeUrl(s.pickupPhoto || s.pickupPhotoUrl || s.itemPhotoBefore)).find(Boolean) ||
        podPickupPhoto || null;

    const rootDelivery = safeUrl(obj.deliveryPhoto || obj.itemPhotoAfter || obj.podPhoto || obj.proofPhoto) ||
        allSubs.map(s => safeUrl(s.deliveryPhoto || s.deliveryPhotoUrl || s.itemPhotoAfter || s.podPhoto || s.proofPhoto)).find(Boolean) ||
        podDeliveryPhoto || null;

    obj.pickupPhotoUrl = rootPickup;
    obj.deliveryPhotoUrl = rootDelivery;
    obj.pickupPhoto = rootPickup;
    obj.deliveryPhoto = rootDelivery;
    obj.itemPhotoBefore = rootPickup;
    obj.itemPhotoAfter = rootDelivery;

    // Aggregate unique photos across group and attempts
    const pickupPhotoSet = new Set(podPickupList);
    const deliveryPhotoSet = new Set(podDeliveryList);
    if (rootPickup) pickupPhotoSet.add(rootPickup);
    if (rootDelivery) deliveryPhotoSet.add(rootDelivery);

    allSubs.forEach(s => {
        const p = safeUrl(s.pickupPhoto || s.pickupPhotoUrl || s.itemPhotoBefore);
        const d = safeUrl(s.deliveryPhoto || s.deliveryPhotoUrl || s.itemPhotoAfter || s.podPhoto || s.proofPhoto);
        if (p) pickupPhotoSet.add(p);
        if (d) deliveryPhotoSet.add(d);
    });

    let globalItemCounter = 0;

    // Process subOrders individual photos & enrich items inside subOrders
    if (allSubs.length > 0) {
        const isSingleSub = allSubs.length === 1;
        obj.subOrders = allSubs.map((sub) => {
            const subP = safeUrl(sub.pickupPhoto || sub.pickupPhotoUrl || sub.itemPhotoBefore) || (isSingleSub ? rootPickup : null);
            const subD = safeUrl(sub.deliveryPhoto || sub.deliveryPhotoUrl || sub.itemPhotoAfter || sub.podPhoto || sub.proofPhoto) || (isSingleSub ? rootDelivery : null);

            const subItems = Array.isArray(sub.items) ? sub.items : [];
            const isSingleSubItem = subItems.length === 1 && allSubs.length === 1;

            const enrichedItems = subItems.map(item => {
                const itemIdx = globalItemCounter++;
                const isSingle = isSingleSubItem;

                let iP = null;
                if (podPickupList.length > 1 && podPickupList[itemIdx]) {
                    iP = podPickupList[itemIdx];
                } else if (safeUrl(item.pickupPhoto || item.pickupPhotoUrl || item.itemPhotoBefore)) {
                    iP = safeUrl(item.pickupPhoto || item.pickupPhotoUrl || item.itemPhotoBefore);
                } else if (isSingle) {
                    iP = podPickupList[0] || subP || rootPickup || null;
                } else {
                    iP = podPickupList[itemIdx] || null;
                }

                let iD = null;
                if (podDeliveryList.length > 1 && podDeliveryList[itemIdx]) {
                    iD = podDeliveryList[itemIdx];
                } else if (safeUrl(item.deliveryPhoto || item.deliveryPhotoUrl || item.itemPhotoAfter || item.podPhoto || item.proofPhoto)) {
                    iD = safeUrl(item.deliveryPhoto || item.deliveryPhotoUrl || item.itemPhotoAfter || item.podPhoto || item.proofPhoto);
                } else if (isSingle) {
                    iD = podDeliveryList[0] || subD || rootDelivery || null;
                } else {
                    iD = podDeliveryList[itemIdx] || null;
                }

                if (iP) pickupPhotoSet.add(iP);
                if (iD) deliveryPhotoSet.add(iD);

                return {
                    ...item,
                    pickupPhoto: iP,
                    pickupPhotoUrl: iP,
                    itemPhotoBefore: iP,
                    deliveryPhoto: iD,
                    deliveryPhotoUrl: iD,
                    itemPhotoAfter: iD,
                };
            });

            return {
                ...sub,
                pickupPhoto: subP,
                pickupPhotoUrl: subP,
                itemPhotoBefore: subP,
                deliveryPhoto: subD,
                deliveryPhotoUrl: subD,
                itemPhotoAfter: subD,
                items: enrichedItems,
            };
        });
    }

    if (Array.isArray(obj.items)) {
        const isSingleRootItem = obj.items.length === 1;
        let rootItemCounter = 0;
        obj.items = obj.items.map(item => {
            const itemIdx = rootItemCounter++;
            const isSingle = isSingleRootItem;

            let iP = null;
            if (podPickupList.length > 1 && podPickupList[itemIdx]) {
                iP = podPickupList[itemIdx];
            } else if (safeUrl(item.pickupPhoto || item.pickupPhotoUrl || item.itemPhotoBefore)) {
                iP = safeUrl(item.pickupPhoto || item.pickupPhotoUrl || item.itemPhotoBefore);
            } else if (isSingle) {
                iP = podPickupList[0] || rootPickup || null;
            } else {
                iP = podPickupList[itemIdx] || null;
            }

            let iD = null;
            if (podDeliveryList.length > 1 && podDeliveryList[itemIdx]) {
                iD = podDeliveryList[itemIdx];
            } else if (safeUrl(item.deliveryPhoto || item.deliveryPhotoUrl || item.itemPhotoAfter || item.podPhoto || item.proofPhoto)) {
                iD = safeUrl(item.deliveryPhoto || item.deliveryPhotoUrl || item.itemPhotoAfter || item.podPhoto || item.proofPhoto);
            } else if (isSingle) {
                iD = podDeliveryList[0] || rootDelivery || null;
            } else {
                iD = podDeliveryList[itemIdx] || null;
            }

            if (iP) pickupPhotoSet.add(iP);
            if (iD) deliveryPhotoSet.add(iD);

            return {
                ...item,
                pickupPhoto: iP,
                pickupPhotoUrl: iP,
                itemPhotoBefore: iP,
                deliveryPhoto: iD,
                deliveryPhotoUrl: iD,
                itemPhotoAfter: iD,
            };
        });
    }

    obj.pickupPhotos = Array.from(pickupPhotoSet);
    obj.deliveryPhotos = Array.from(deliveryPhotoSet);

    // ─── Unified Tasks Array for Admin & Representative Order Task Details ─────────
    const isOrderReturn = obj.isReturnOrder === true || (typeof obj.status === 'string' && obj.status.startsWith('return_')) || obj.status === 'returned';

    if (!obj.tasks || obj.tasks.length === 0 || obj.tasks.length < (obj.items?.length || 0)) {
        if (allSubs.length > 1) {
            allSubs.sort((a, b) => {
                const aIdx = a.subOrderIndex || 0;
                const bIdx = b.subOrderIndex || 0;
                if (aIdx !== bIdx && aIdx !== 0 && bIdx !== 0) return aIdx - bIdx;
                const aId = a.storeOrderId || a.taskId || 0;
                const bId = b.storeOrderId || b.taskId || 0;
                if (aId !== bId && aId !== 0 && bId !== 0) return aId - bId;
                const aTime = new Date(a.createdAt || 0).getTime();
                const bTime = new Date(b.createdAt || 0).getTime();
                return aTime - bTime;
            });
            obj.tasks = allSubs.map((sub, idx) => {
                const subStatus = sub.status || obj.status || 'pending';
                const rawSubItems = Array.isArray(sub.items) ? sub.items : [];
                const subItems = [...rawSubItems].sort((a, b) => {
                    const aIdx = a.itemIndex || 0;
                    const bIdx = b.itemIndex || 0;
                    if (aIdx !== bIdx && aIdx !== 0 && bIdx !== 0) return aIdx - bIdx;
                    return 0;
                });
                const firstSubItem = subItems[0] || {};
                const subPickupLoc = (firstSubItem.pickupLocation && (firstSubItem.pickupLocation.lat != null || firstSubItem.pickupLocation.latitude != null))
                    ? firstSubItem.pickupLocation
                    : (sub.pickupLocation || obj.pickupLocation || {});

                const subDeliveryLoc = (firstSubItem.deliveryLocation && (firstSubItem.deliveryLocation.lat != null || firstSubItem.deliveryLocation.latitude != null))
                    ? firstSubItem.deliveryLocation
                    : (sub.deliveryLocation || obj.deliveryLocation || {});

                const subSummary = subItems.map(i => `${i.name} (x${i.quantity || 1})`).join(', ') || 'طلب متجر';

                const subP = sub.pickupPhoto || sub.pickupPhotoUrl || sub.itemPhotoBefore || firstSubItem.pickupPhoto || rootPickup || null;
                const subD = sub.deliveryPhoto || sub.deliveryPhotoUrl || sub.itemPhotoAfter || firstSubItem.deliveryPhoto || rootDelivery || null;

                let subDPrice = sub.deliveryPrice != null ? Number(sub.deliveryPrice) : dPrice;
                while (subDPrice >= 50000) subDPrice = subDPrice / 1000;
                subDPrice = Number(subDPrice.toFixed(3));

                const taskAgentName = resolveRealAgentName(sub.agentId, sub.agentName) || resolvedRootAgentName;
                const taskStreetPickup = subPickupLoc.address || (taskAgentName && !isHexObjectId(taskAgentName) ? taskAgentName : null) || sub.associationName || sub.restaurantName || 'موقع الاستلام';
                const taskGooglePickup = subPickupLoc.address || (taskAgentName && !isHexObjectId(taskAgentName) ? taskAgentName : null) || sub.associationName || sub.restaurantName || '';

                return {
                    taskId: idx + 1,
                    originalSubOrderId: sub._id ? sub._id.toString() : null,
                    storeOrderId: sub.storeOrderId || obj.storeOrderId || null,
                    agentId: sub.agentId || obj.agentId || null,
                    agentName: taskAgentName || null,
                    storeName: taskAgentName || null,
                    associationId: sub.associationId || obj.associationId || null,
                    associationName: sub.associationName || obj.associationName || null,
                    restaurantId: sub.restaurantId || obj.restaurantId || null,
                    restaurantName: sub.restaurantName || obj.restaurantName || null,
                    taskStatus: subStatus,
                    status: subStatus,
                    isDelivered: subStatus === 'delivered' || subStatus === 'completed' || subStatus === 'returned',
                    isReturnTask: isOrderReturn,
                    pickupLocation: {
                        streetName: isOrderReturn ? (subDeliveryLoc.address || 'موقع الاستلام (العميل)') : taskStreetPickup,
                        entranceNumber: '',
                        phoneNumber: isOrderReturn ? (sub.userInfo?.phone || obj.userInfo?.phone || '') : '',
                        isClientInterface: isOrderReturn,
                        roleLabel: isOrderReturn ? 'واجهة عميل (استلام من العميل)' : 'واجهة متجر (استلام)',
                        interfaceNotice: isOrderReturn ? 'تنبيه: أنت الآن في واجهة العميل - استلم المنتجات المرتجعة وحصّل رسوم التوصيل' : null,
                    },
                    deliveryLocation: {
                        streetName: isOrderReturn ? (taskStreetPickup || 'موقع التسليم (المتجر)') : (subDeliveryLoc.address || 'موقع التسليم (العميل)'),
                        entranceNumber: '',
                        phoneNumber: isOrderReturn ? '' : (sub.userInfo?.phone || obj.userInfo?.phone || ''),
                        isAgentInterface: isOrderReturn,
                        roleLabel: isOrderReturn ? 'واجهة وكيل (تسليم للمتجر)' : 'واجهة عميل (تسليم)',
                        interfaceNotice: isOrderReturn ? 'تنبيه: أنت الآن في واجهة الوكيل - سلّم الشحنة المرتجعة للمتجر' : null,
                    },
                    googleMapAddressFrom: isOrderReturn ? (subDeliveryLoc.address || '') : taskGooglePickup,
                    googleMapAddressTo: isOrderReturn ? taskGooglePickup : (subDeliveryLoc.address || ''),
                    fromLatitude: isOrderReturn ? (subDeliveryLoc.lat ?? subDeliveryLoc.latitude ?? null) : (subPickupLoc.lat ?? subPickupLoc.latitude ?? null),
                    fromLongitude: isOrderReturn ? (subDeliveryLoc.lng ?? subDeliveryLoc.longitude ?? null) : (subPickupLoc.lng ?? subPickupLoc.longitude ?? null),
                    toLatitude: isOrderReturn ? (subPickupLoc.lat ?? subPickupLoc.latitude ?? null) : (subDeliveryLoc.lat ?? subDeliveryLoc.latitude ?? null),
                    toLongitude: isOrderReturn ? (subPickupLoc.lng ?? subPickupLoc.longitude ?? null) : (subDeliveryLoc.lng ?? subDeliveryLoc.longitude ?? null),
                    type: 'delivery',
                    deliveryDescription: subSummary,
                    distanceKm: sub.deliveryDistanceMeters ? (sub.deliveryDistanceMeters / 1000).toFixed(2) : '0',
                    deliveryPrice: subDPrice,
                    itemPhotoBefore: subP,
                    itemPhotoAfter: subD,
                    pickupPhoto: subP,
                    deliveryPhoto: subD,
                    pickupPhotoUrl: subP,
                    deliveryPhotoUrl: subD,
                    purchaseItems: subItems.map(i => ({
                        name: i.name,
                        quantity: i.quantity || 1,
                        price: i.price || 0,
                    })),
                    items: subItems,
                };
            });
        } else if (Array.isArray(obj.items) && obj.items.length > 0) {
            const rawStatus = obj.status || 'pending';
            let normStatus = rawStatus;
            if (rawStatus === 'delivered' || rawStatus === 'returned') normStatus = 'completed';
            else if (rawStatus === 'cancelled' || rawStatus === 'return_cancelled') normStatus = 'cancelled';
            else if (['confirmed', 'processing', 'shipped', 'return_accepted', 'return_delivering'].includes(rawStatus)) normStatus = 'inprogress';

            const sortedItems = [...obj.items].sort((a, b) => {
                const aIdx = a.itemIndex || 0;
                const bIdx = b.itemIndex || 0;
                if (aIdx !== bIdx && aIdx !== 0 && bIdx !== 0) return aIdx - bIdx;
                return 0;
            });

            obj.tasks = sortedItems.map((item, idx) => {
                const itemPickupLoc = (item.pickupLocation && (item.pickupLocation.lat != null || item.pickupLocation.latitude != null))
                    ? item.pickupLocation
                    : (obj.pickupLocation || {});

                const itemDeliveryLoc = (item.deliveryLocation && (item.deliveryLocation.lat != null || item.deliveryLocation.latitude != null))
                    ? item.deliveryLocation
                    : (obj.deliveryLocation || {});

                const itemP = item.pickupPhoto || item.pickupPhotoUrl || item.itemPhotoBefore || (obj.items.length === 1 ? rootPickup : null);
                const itemD = item.deliveryPhoto || item.deliveryPhotoUrl || item.itemPhotoAfter || (obj.items.length === 1 ? rootDelivery : null);

                const itemRawStatus = item.status || (rawStatus === 'delivered' ? 'delivered' : rawStatus);
                let itemNormStatus = itemRawStatus;
                if (itemRawStatus === 'delivered' || itemRawStatus === 'completed' || itemRawStatus === 'returned') itemNormStatus = 'completed';
                else if (itemRawStatus === 'cancelled' || itemRawStatus === 'return_cancelled') itemNormStatus = 'cancelled';
                else if (['confirmed', 'processing', 'shipped', 'picked_up', 'return_accepted', 'return_delivering'].includes(itemRawStatus)) itemNormStatus = 'inprogress';
                else itemNormStatus = normStatus;

                const isItemDelivered = item.status === 'delivered' || item.isDelivered === true || rawStatus === 'delivered' || rawStatus === 'completed' || rawStatus === 'returned' || item.status === 'returned';
                const isItemPickedUp = item.isPickedUp === true || item.status === 'shipped' || isItemDelivered || rawStatus === 'shipped' || rawStatus === 'delivered' || rawStatus === 'returned' || rawStatus === 'return_delivering' || !!itemP;

                const taskAgentName = resolveRealAgentName(item.agentId, item.agentName) || resolvedRootAgentName;
                const taskStreetPickup = itemPickupLoc.address || (taskAgentName && !isHexObjectId(taskAgentName) ? taskAgentName : null) || obj.associationName || obj.restaurantName || 'موقع الاستلام';
                const taskGooglePickup = itemPickupLoc.address || (taskAgentName && !isHexObjectId(taskAgentName) ? taskAgentName : null) || obj.associationName || obj.restaurantName || '';

                return {
                    taskId: idx + 1,
                    originalSubOrderId: obj._id ? obj._id.toString() : null,
                    storeOrderId: obj.storeOrderId || obj.orderId || null,
                    agentId: item.agentId || obj.agentId || null,
                    agentName: taskAgentName || null,
                    storeName: taskAgentName || null,
                    associationId: item.associationId || obj.associationId || null,
                    associationName: item.associationName || obj.associationName || null,
                    restaurantId: item.restaurantId || obj.restaurantId || null,
                    restaurantName: item.restaurantName || obj.restaurantName || null,
                    taskStatus: itemNormStatus,
                    status: itemNormStatus,
                    isDelivered: isItemDelivered,
                    isDelevered: isItemDelivered,
                    isPickedUp: isItemPickedUp,
                    pickedUp: isItemPickedUp,
                    isReturnTask: isOrderReturn,
                    pickupLocation: {
                        streetName: isOrderReturn ? (itemDeliveryLoc.address || 'موقع الاستلام (العميل)') : taskStreetPickup,
                        entranceNumber: '',
                        phoneNumber: isOrderReturn ? (obj.userInfo?.phone || '') : '',
                        isClientInterface: isOrderReturn,
                        roleLabel: isOrderReturn ? 'واجهة عميل (استلام من العميل)' : 'واجهة متجر (استلام)',
                        interfaceNotice: isOrderReturn ? 'تنبيه: أنت الآن في واجهة العميل - استلم المنتجات المرتجعة وحصّل رسوم التوصيل' : null,
                    },
                    deliveryLocation: {
                        streetName: isOrderReturn ? (taskStreetPickup || 'موقع التسليم (المتجر)') : (itemDeliveryLoc.address || 'موقع التسليم (العميل)'),
                        entranceNumber: '',
                        phoneNumber: isOrderReturn ? '' : (obj.userInfo?.phone || ''),
                        isAgentInterface: isOrderReturn,
                        roleLabel: isOrderReturn ? 'واجهة وكيل (تسليم للمتجر)' : 'واجهة عميل (تسليم)',
                        interfaceNotice: isOrderReturn ? 'تنبيه: أنت الآن في واجهة الوكيل - سلّم الشحنة المرتجعة للمتجر' : null,
                    },
                    googleMapAddressFrom: isOrderReturn ? (itemDeliveryLoc.address || '') : taskGooglePickup,
                    googleMapAddressTo: isOrderReturn ? taskGooglePickup : (itemDeliveryLoc.address || ''),
                    fromLatitude: isOrderReturn ? (itemDeliveryLoc.lat ?? itemDeliveryLoc.latitude ?? null) : (itemPickupLoc.lat ?? itemPickupLoc.latitude ?? null),
                    fromLongitude: isOrderReturn ? (itemDeliveryLoc.lng ?? itemDeliveryLoc.longitude ?? null) : (itemPickupLoc.lng ?? itemPickupLoc.longitude ?? null),
                    toLatitude: isOrderReturn ? (itemPickupLoc.lat ?? itemPickupLoc.latitude ?? null) : (itemDeliveryLoc.lat ?? itemDeliveryLoc.latitude ?? null),
                    toLongitude: isOrderReturn ? (itemPickupLoc.lng ?? itemPickupLoc.longitude ?? null) : (itemDeliveryLoc.lng ?? itemDeliveryLoc.longitude ?? null),
                    type: 'delivery',
                    deliveryDescription: `${item.name} (x${item.quantity || 1})`,
                    distanceKm: obj.deliveryDistanceMeters ? (obj.deliveryDistanceMeters / 1000).toFixed(2) : '0',
                    deliveryPrice: dPrice,
                    itemPhotoBefore: itemP,
                    itemPhotoAfter: itemD,
                    pickupPhoto: itemP,
                    deliveryPhoto: itemD,
                    pickupPhotoUrl: itemP,
                    deliveryPhotoUrl: itemD,
                    purchaseItems: [{
                        name: item.name,
                        quantity: item.quantity || 1,
                        price: item.price || 0,
                    }],
                    items: [item],
                };
            });
        }
    }

    // Batch enrich representative details if representativeId is set
    if (obj.representativeId && (!obj.representativeName || !obj.driverName) && mongoose.connection.readyState === 1) {
        try {
            const rep = await User.findById(obj.representativeId)
                .select('firstName lastName phone profileImage vehicleNumber vehicleColor vehicleModel vehicleImage email userType isAvailable createdAt')
                .lean();
            if (rep) {
                const repName = `${rep.firstName || ''} ${rep.lastName || ''}`.trim() || null;
                obj.representativeName = repName;
                obj.driverName = repName;
                obj.representativePhone = rep.phone || null;
                obj.driverPhoneNumber = rep.phone || null;
                obj.representativeEmail = rep.email || null;
                obj.representativeProfileImage = safeUrl(rep.profileImage);
                obj.driverPhotoUrl = obj.representativeProfileImage;
                obj.representativeUserType = rep.userType || null;
                obj.representativeIsAvailable = rep.isAvailable ?? null;
                obj.representativeJoinedAt = rep.createdAt || null;
                obj.vehicleNumber = rep.vehicleNumber || null;
                obj.vehicleColor = rep.vehicleColor || null;
                obj.vehicleModel = rep.vehicleModel || null;
                obj.vehicleImage = safeUrl(rep.vehicleImage);
            }
        } catch (_) { /* non-critical */ }
    }

    obj.acceptedAt = obj.acceptedAt || null;
    obj.arrivalConfirmedAt = obj.arrivalConfirmedAt || null;
    obj.arrivalTimerExpiredAt = obj.arrivalTimerExpiredAt || null;
    obj.isClientDelayed = obj.isClientDelayed || false;
    obj.delayedAt = obj.delayedAt || null;

    // Ensure root order has highest requiredVehicleTypeName and requiredVehicleTypeId resolved
    try {
        const vehCandidates = [
            { requiredVehicleTypeId: obj.requiredVehicleTypeId, requiredVehicleTypeName: obj.requiredVehicleTypeName },
            ...(obj.items || []),
            ...(obj.subOrders || []).flatMap(s => [
                { requiredVehicleTypeId: s.requiredVehicleTypeId, requiredVehicleTypeName: s.requiredVehicleTypeName },
                ...(s.items || [])
            ])
        ];
        const highestVeh = getHighestVehicleType(vehCandidates);
        if (highestVeh.requiredVehicleTypeName) {
            obj.requiredVehicleTypeId = highestVeh.requiredVehicleTypeId || obj.requiredVehicleTypeId;
            obj.requiredVehicleTypeName = highestVeh.requiredVehicleTypeName;
        }
    } catch (_) { }

    try {
        const orderRef = obj.parentGroupId || obj.storeOrderId || obj._id || obj.orderId;
        const trackData = await BusinessOrderTracker.getOrderTrack(orderRef);
        if (trackData) {
            obj.track = trackData;
            obj.currentStopIndex = trackData.currentStopIndex;
            obj.currentStop = trackData.currentStop;
            obj.stops = trackData.stops;
            obj.allPickupsDone = trackData.allPickupsDone;
            obj.isAllCompleted = trackData.isAllCompleted;
            obj.phase = trackData.phase;
        }
    } catch (_) { }

    // ─── Return System Metadata (بيانات نظام الاسترجاع والأهلية) ───────────────
    const isOrderDelivered = obj.status === 'delivered' || obj.status === 'completed';
    const deliveryTimestamp = obj.deliveredAt || (isOrderDelivered ? (obj.updatedAt || new Date()) : null);
    const maxReturnWindowMs = 48 * 60 * 60 * 1000;
    let isEligibleForReturn = false;
    let returnHoursRemaining = 0;
    let returnWindowExpired = false;

    if (isOrderDelivered) {
        if (obj.deliveredAt) {
            const elapsed = Date.now() - new Date(obj.deliveredAt).getTime();
            if (elapsed <= maxReturnWindowMs) {
                isEligibleForReturn = true;
                returnHoursRemaining = Math.max(0, Number(((maxReturnWindowMs - elapsed) / (60 * 60 * 1000)).toFixed(1)));
            } else {
                returnWindowExpired = true;
            }
        } else {
            // deliveredAt was not yet stamped on document: treat newly delivered order as fresh (48h remaining)
            isEligibleForReturn = true;
            returnHoursRemaining = 48.0;
            returnWindowExpired = false;
        }
    }

    const isAlreadyReturning = Boolean(
        obj.isReturnOrder === true ||
        (typeof obj.status === 'string' && obj.status.startsWith('return_')) ||
        obj.status === 'returned'
    );

    obj.canReturn = isEligibleForReturn && !isAlreadyReturning;
    obj.returnWindowRemainingHours = returnHoursRemaining;
    obj.returnWindowExpired = returnWindowExpired;
    if (deliveryTimestamp) {
        obj.deliveredAt = deliveryTimestamp;
    }

    if (isAlreadyReturning) {
        obj.isReturnOrder = true;
        obj.returnBannerNotice = 'طلب مرتجع: يتم الاستلام من العميل والتسليم للمتجر/الوكيل';
        obj.returnDetails = obj.returnDetails || {};
    }

    const returnReason = obj.returnReason || obj.returnDetails?.reason || null;
    obj.returnReason = returnReason;
    if (obj.returnDetails && typeof obj.returnDetails === 'object') {
        if (returnReason && !obj.returnDetails.reason) {
            obj.returnDetails.reason = returnReason;
        }
    } else if (returnReason) {
        obj.returnDetails = { reason: returnReason };
    }

    return obj;
}

// Keep backward-compatible alias
const enrichOrderImages = enrichOrder;

/** Deduct stock and auto-set isSoldOut for each item in a list using atomic conditional updates */
async function deductStock(items, session = null) {
    const result = await deductProductStockAtomically(items, session);
    if (!result.success) {
        const err = new Error(result.message);
        err.code = result.code;
        err.details = result.details;
        throw err;
    }
    return result;
}

// ─── Helper: Arabic Normalization for Vehicle Type Matching ──────────────────
function normalizeArabic(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/[\u064B-\u065F\u0670]/g, '') // remove tashkeel
        .replace(/ـ/g, '') // remove tatweel
        .trim();
}

/**
 * @desc Vehicle Classification & Hierarchy Ranking for Business Orders
 * Scale:
 *  10: SCOOTER / BICYCLE (سكوتر / دراجة)
 *  20: MOTORCYCLE (موتوسيكل / موتسيكل / دراجة نارية)
 *  30: SEDAN (ملاكي / عربيه ملاكي / صالون / سيارة)
 *  40: CARGO_VAN (فان بضائع / فان)
 *  50: SMALL_HALF_LORRY (هاف لوري صغير / بيك اب / وانيت صغير)
 *  60: REFRIGERATED (مبردة / مبرده / شاحنة مبردة / براد)
 *  70: LARGE_HALF_LORRY (هاف لوري كبير / هاف لوري)
 *  80: HEAVY_TRUCK (شاحنة كبيرة / لوري كبير)
 *  90: CAR_TRANSPORTER (ناقلة عربيات / سطحة)
 * 100: TRAILER (تريلا / مقطورة)
 */
function getVehicleMeta(typeName) {
    if (!typeName) return { rank: 0, canonicalName: null, canonicalKey: null };
    const norm = normalizeArabic(typeName);
    if (!norm) return { rank: 0, canonicalName: null, canonicalKey: null };

    // 10. تريلا (Trailer)
    if (norm.includes('تريل') || norm.includes('مقطور') || norm.includes('semi trailer') || norm.includes('trailer')) {
        return { rank: 100, canonicalName: 'تريلا', canonicalKey: 'TRAILER' };
    }

    // 9. ناقلة عربيات (Car Transporter)
    if (norm.includes('ناقل') || norm.includes('سطح') || norm.includes('transporter') || norm.includes('flatbed') || norm.includes('tow')) {
        return { rank: 90, canonicalName: 'ناقلة عربيات', canonicalKey: 'CAR_TRANSPORTER' };
    }

    // 8. شاحنة كبيرة (Heavy Truck)
    if (
        (norm.includes('شاحن') && (norm.includes('كبير') || norm.includes('ثقيل') || norm.includes('heavy') || norm.includes('big'))) ||
        norm.includes('heavy truck') || norm.includes('big truck') || norm.includes('جامبو')
    ) {
        return { rank: 80, canonicalName: 'شاحنة كبيرة', canonicalKey: 'HEAVY_TRUCK' };
    }

    // 7. هاف لوري كبير (Large Half-Lorry / Medium Truck)
    // "هاف" with "كبير", OR "هاف لوري" / "نص لوري" where "صغير" is not specified
    if (
        (norm.includes('هاف') || norm.includes('نص لوري') || norm.includes('نصف لوري') || norm.includes('half lorry')) &&
        (norm.includes('كبير') || norm.includes('large') || norm.includes('big') || (!norm.includes('صغير') && !norm.includes('small')))
    ) {
        return { rank: 70, canonicalName: 'هاف لوري كبير', canonicalKey: 'LARGE_HALF_LORRY' };
    }

    // 6. مبردة (Refrigerated)
    if (
        norm.includes('مبرد') || norm.includes('براد') || norm.includes('ثلاج') ||
        norm.includes('refrigerat') || norm.includes('reefer') || norm.includes('chilled') || norm.includes('freezer')
    ) {
        return { rank: 60, canonicalName: 'مبردة', canonicalKey: 'REFRIGERATED' };
    }

    // 5. هاف لوري صغير (Small Half-Lorry / Pickup)
    if (
        ((norm.includes('هاف') || norm.includes('نص لوري') || norm.includes('نصف لوري') || norm.includes('half lorry')) && (norm.includes('صغير') || norm.includes('small'))) ||
        norm.includes('بيك اب') || norm.includes('بيكاب') || norm.includes('وانيت') || (norm.includes('شاحن') && (norm.includes('صغير') || norm.includes('small')))
    ) {
        return { rank: 50, canonicalName: 'هاف لوري صغير', canonicalKey: 'SMALL_HALF_LORRY' };
    }

    // 4. فان بضائع (Cargo Van)
    if (norm.includes('فان') || norm.includes('van') || norm.includes('بضائع') || norm.includes('بضايع')) {
        return { rank: 40, canonicalName: 'فان بضائع', canonicalKey: 'CARGO_VAN' };
    }

    // 3. ملاكي (Sedan / Private Car)
    if (
        norm.includes('ملاك') || norm.includes('سيار') || norm.includes('عربيه') ||
        norm.includes('صالون') || norm.includes('سيدان') || norm.includes('sedan') || norm.includes('car') || norm.includes('salon')
    ) {
        return { rank: 30, canonicalName: 'ملاكي', canonicalKey: 'SEDAN' };
    }

    // 2. موتوسيكل (Motorcycle)
    if (
        norm.includes('موتوسيكل') || norm.includes('موتسيكل') || (norm.includes('دراج') && norm.includes('ناري')) ||
        norm.includes('motorcycle') || norm.includes('motorbike') || norm.includes('bike')
    ) {
        return { rank: 20, canonicalName: 'موتوسيكل', canonicalKey: 'MOTORCYCLE' };
    }

    // 1. سكوتر / دراجة (Scooter / Bicycle)
    if (norm.includes('سكوتر') || norm.includes('دراج') || norm.includes('عجل') || norm.includes('scooter') || norm.includes('bicycle')) {
        return { rank: 10, canonicalName: 'سكوتر', canonicalKey: 'SCOOTER' };
    }

    return { rank: 15, canonicalName: typeName.toString().trim(), canonicalKey: 'OTHER' };
}

function getVehicleRank(typeName) {
    return getVehicleMeta(typeName).rank;
}

function getHighestVehicleType(candidates) {
    let highestRank = 0;
    let highestObj = { requiredVehicleTypeId: null, requiredVehicleTypeName: null, canonicalKey: null, rank: 0 };

    if (!Array.isArray(candidates)) return highestObj;

    for (const c of candidates) {
        if (!c) continue;
        const name = c.requiredVehicleTypeName || c.name || c.vehicleTypeName || '';
        const meta = getVehicleMeta(name);
        if (meta.rank > highestRank) {
            highestRank = meta.rank;
            highestObj = {
                requiredVehicleTypeId: c.requiredVehicleTypeId || c.vehicleTypeId || c._id || null,
                requiredVehicleTypeName: meta.canonicalName || (name ? name.toString().trim() : null),
                canonicalKey: meta.canonicalKey,
                rank: meta.rank,
            };
        }
    }
    return highestObj;
}

function groupStoreOrders(orders) {
    const displayOrders = [];
    const seenGroups = {};
    for (let i = 0; i < orders.length; i++) {
        const o = orders[i].toObject ? orders[i].toObject() : { ...orders[i] };
        const gid = o.parentGroupId || (o.storeOrderId ? `store_${o.storeOrderId}` : null);
        if (!gid) {
            const highestVeh = getHighestVehicleType([
                { requiredVehicleTypeId: o.requiredVehicleTypeId, requiredVehicleTypeName: o.requiredVehicleTypeName },
                ...(o.items || [])
            ]);
            if (highestVeh.requiredVehicleTypeName) {
                o.requiredVehicleTypeId = highestVeh.requiredVehicleTypeId || o.requiredVehicleTypeId;
                o.requiredVehicleTypeName = highestVeh.requiredVehicleTypeName || o.requiredVehicleTypeName;
            }
            displayOrders.push(o);
        } else {
            if (!seenGroups[gid]) {
                const parent = { ...o, _id: o.parentGroupId || o._id, subOrders: [], items: [...(o.items || [])] };
                const subOrder = { ...o, items: [...(o.items || [])] };
                parent.subOrders.push(subOrder);
                seenGroups[gid] = parent;
                displayOrders.push(parent);
            } else {
                const parent = seenGroups[gid];
                parent.items.push(...(o.items || []));
                parent.totalPrice += o.totalPrice;
                if (o.deliveryPrice) parent.deliveryPrice = Math.max(parent.deliveryPrice || 0, o.deliveryPrice);
                if (o.deliveryDistanceMeters) parent.deliveryDistanceMeters = Math.max(parent.deliveryDistanceMeters || 0, o.deliveryDistanceMeters);
                if (o.totalDeliveryPrice) parent.totalDeliveryPrice = Math.max(parent.totalDeliveryPrice || 0, o.totalDeliveryPrice);
                if (o.totalDistanceKm) parent.totalDistanceKm = Math.max(parent.totalDistanceKm || 0, o.totalDistanceKm);
                if (o.agentId && (!parent.involvedAgents || !parent.involvedAgents.includes(o.agentId))) {
                    if (!parent.involvedAgents) parent.involvedAgents = [];
                    parent.involvedAgents.push(o.agentId);
                }
                if (o.representativeId && !parent.representativeId) {
                    parent.representativeId = o.representativeId;
                }
                const subOrder = { ...o, items: [...(o.items || [])] };
                parent.subOrders.push(subOrder);
            }

            const parentGroup = seenGroups[gid];
            parentGroup.subOrders.sort((a, b) => {
                const aIdx = a.subOrderIndex || 0;
                const bIdx = b.subOrderIndex || 0;
                if (aIdx !== bIdx && aIdx !== 0 && bIdx !== 0) return aIdx - bIdx;
                const aId = a.storeOrderId || a.taskId || 0;
                const bId = b.storeOrderId || b.taskId || 0;
                if (aId !== bId && aId !== 0 && bId !== 0) return aId - bId;
                const aTime = new Date(a.createdAt || 0).getTime();
                const bTime = new Date(b.createdAt || 0).getTime();
                return aTime - bTime;
            });
            const allSubs = parentGroup.subOrders || [];

            // Reconstruct items in exact subOrder and itemIndex order
            parentGroup.items = allSubs.flatMap(s => s.items || []).sort((a, b) => {
                const aIdx = a.itemIndex || 0;
                const bIdx = b.itemIndex || 0;
                if (aIdx !== bIdx && aIdx !== 0 && bIdx !== 0) return aIdx - bIdx;
                return 0;
            });

            // ─── Status aggregation across all sub-orders ───
            const allReturned = allSubs.length > 0 && allSubs.every(s => s.status === 'returned');
            const anyReturnDelivering = allSubs.some(s => s.status === 'return_delivering');
            const anyReturnAccepted = allSubs.some(s => s.status === 'return_accepted');
            const anyReturnPending = allSubs.some(s => s.status === 'return_pending');
            const allDelivered = allSubs.length > 0 && allSubs.every(s => (s.status === 'delivered' || s.status === 'completed') && (!Array.isArray(s.items) || s.items.length === 0 || s.items.every(it => it.status === 'delivered' || it.isDelivered === true)));
            const allCancelled = allSubs.length > 0 && allSubs.every(s => s.status === 'cancelled');
            const anyShipped = allSubs.some(s => s.status === 'shipped' || s.status === 'delivering');
            const anyConfirmed = allSubs.some(s => s.status === 'confirmed' || s.status === 'processing');

            if (allReturned) {
                parentGroup.status = 'returned';
            } else if (anyReturnDelivering) {
                parentGroup.status = 'return_delivering';
            } else if (anyReturnAccepted) {
                parentGroup.status = 'return_accepted';
            } else if (anyReturnPending) {
                parentGroup.status = 'return_pending';
            } else if (allDelivered) {
                parentGroup.status = 'delivered';
            } else if (allCancelled) {
                parentGroup.status = 'cancelled';
            } else if (anyShipped) {
                parentGroup.status = 'shipped';
            } else if (anyConfirmed) {
                parentGroup.status = 'confirmed';
            } else {
                parentGroup.status = allSubs[0]?.status || 'pending';
            }

            const retDet = allSubs.map(s => s.returnDetails).find(Boolean) || parentGroup.returnDetails || null;
            const retReas = allSubs.map(s => s.returnReason || s.returnDetails?.reason).find(Boolean) || parentGroup.returnReason || (retDet ? retDet.reason : null);
            parentGroup.returnDetails = retDet;
            parentGroup.returnReason = retReas;
            if (allSubs.some(s => s.isReturnOrder)) {
                parentGroup.isReturnOrder = true;
            }

            const firstSub = allSubs[0];
            if (firstSub) {
                if (firstSub.agentId) parentGroup.agentId = firstSub.agentId;
                if (firstSub.agentName) parentGroup.agentName = firstSub.agentName;
                if (firstSub.associationId) parentGroup.associationId = firstSub.associationId;
                if (firstSub.associationName) parentGroup.associationName = firstSub.associationName;
                if (firstSub.restaurantId) parentGroup.restaurantId = firstSub.restaurantId;
                if (firstSub.restaurantName) parentGroup.restaurantName = firstSub.restaurantName;
                if (firstSub.pickupLocation) parentGroup.pickupLocation = firstSub.pickupLocation;
            }

            // Aggregate photos across all sub-orders in the group so root parent object gets non-null pickup & delivery photos
            const rootP = allSubs.map(s => s.pickupPhoto || s.pickupPhotoUrl || s.itemPhotoBefore).find(Boolean) || parentGroup.pickupPhoto || null;
            const rootD = allSubs.map(s => s.deliveryPhoto || s.deliveryPhotoUrl || s.itemPhotoAfter || s.podPhoto || s.proofPhoto).find(Boolean) || parentGroup.deliveryPhoto || null;

            parentGroup.pickupPhoto = rootP;
            parentGroup.pickupPhotoUrl = rootP;
            parentGroup.itemPhotoBefore = rootP;

            parentGroup.deliveryPhoto = rootD;
            parentGroup.deliveryPhotoUrl = rootD;
            parentGroup.itemPhotoAfter = rootD;

            const allCandidates = [
                ...allSubs.flatMap(s => [
                    { requiredVehicleTypeId: s.requiredVehicleTypeId, requiredVehicleTypeName: s.requiredVehicleTypeName },
                    ...(s.items || [])
                ]),
                ...(parentGroup.items || [])
            ];
            const highestVeh = getHighestVehicleType(allCandidates);
            if (highestVeh.requiredVehicleTypeName) {
                parentGroup.requiredVehicleTypeId = highestVeh.requiredVehicleTypeId || parentGroup.requiredVehicleTypeId;
                parentGroup.requiredVehicleTypeName = highestVeh.requiredVehicleTypeName || parentGroup.requiredVehicleTypeName;
            }

            // ─── Return System Aggregation for parentGroup ───
            parentGroup.canReturn = allSubs.some(s => s.canReturn === true);
            parentGroup.returnWindowExpired = allSubs.length > 0 && allSubs.every(s => s.returnWindowExpired === true);
            const maxRemaining = Math.max(0, ...allSubs.map(s => Number(s.returnWindowRemainingHours) || 0));
            parentGroup.returnWindowRemainingHours = maxRemaining;
            parentGroup.deliveredAt = allSubs.map(s => s.deliveredAt).find(Boolean) || (allDelivered ? new Date() : null);
        }
    }
    return displayOrders;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * @desc   Checkout – create split store orders from the user's cart
 * @route  POST /api/store/orders/checkout
 *
 * Logic:
 *  1. Each cart item can carry its own deliveryLocation.
 *  2. Items are grouped by their primary agent (agentId on the Product).
 *  3. One StoreOrder is created per agent group — each with a unique storeOrderId.
 *  4. All sub-orders share the same parentGroupId (UUID) so the representative
 *     can fetch the full order picture via GET /api/store/orders/group/:groupId.
 */
const checkout = async (req, res) => {
    let session = null;
    let inTransaction = false;
    let reservedItems = [];

    try {
        const { error, value } = validateCreateStoreOrder(req.body);
        if (error) return res.status(400).json({ message: error.details.map(d => d.message).join(', ') });

        const userId = req.user?.id || req.user?._id;
        const checkUserId = value.clientId || userId;

        // ─── فحص محفظة العميل: يمنع الشراء إذا تجاوزت المديونية الحد الأقصى ─────────
        try {
            const { checkWalletCanOrder } = require('../middlewares/Wallet');
            const walletCheck = await checkWalletCanOrder(checkUserId);
            if (!walletCheck.canOrder) {
                return res.status(402).json({
                    code: 'WALLET_NEGATIVE_BALANCE',
                    message: walletCheck.message,
                    balanceFils: walletCheck.balanceFils,
                    balanceKWD: walletCheck.balanceKWD,
                    minBalanceFils: walletCheck.minBalanceFils,
                    minBalanceKWD: walletCheck.minBalanceKWD,
                });
            }
        } catch (walletCheckErr) {
            console.error('[checkout] Wallet check error:', walletCheckErr.message);
        }

        // Load cart
        const cart = await Cart.findOne({ userId }).populate('items.product');
        if (!cart || cart.items.length === 0) {
            return res.status(400).json({ message: 'Your cart is empty' });
        }

        // Quick pre-validation for active products
        for (const item of cart.items) {
            const p = item.product;
            if (!p || !p.isActive) {
                return res.status(400).json({
                    code: 'PRODUCT_NOT_AVAILABLE',
                    message: `Product "${p?.name || 'Unknown'}" is no longer available`,
                });
            }
        }

        // ── Start Transaction if supported by MongoDB connection ─────────────
        if (supportsTransactions()) {
            try {
                session = await mongoose.startSession();
                session.startTransaction();
                inTransaction = true;
            } catch (_) {
                session = null;
                inTransaction = false;
            }
        }

        // ── Deduct stock atomically (zero race conditions, ACID or compensating rollback) ──
        const deduction = await deductProductStockAtomically(cart.items, session);
        if (!deduction.success) {
            if (inTransaction && session) {
                await session.abortTransaction();
                await session.endSession();
            }
            return res.status(400).json({
                code: deduction.code || 'INSUFFICIENT_STOCK',
                message: deduction.message,
                details: deduction.details,
            });
        }
        reservedItems = deduction.reservedItems || [];

        // Load user info
        const user = await User.findById(userId).select('firstName lastName email phone');

        // ── Batch-fetch association data for all cart products that have associationId ──
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

        // ── Batch-fetch restaurant data for all cart products that have restaurantId ──
        const restaurantIds = [
            ...new Set(
                cart.items
                    .map(i => i.product?.restaurantId?.toString())
                    .filter(Boolean)
            )
        ];
        const restaurantMap = {};
        if (restaurantIds.length > 0) {
            const rests = await Restaurant.find(
                { _id: { $in: restaurantIds } },
                { name: 1, pickupLocation: 1, requiredVehicleTypeId: 1, requiredVehicleTypeName: 1, deliveryPricePerMeter: 1, deliveryFlatFee: 1, agentId: 1, agentName: 1 }
            );
            rests.forEach(r => { restaurantMap[r._id.toString()] = r; });
        }

        // ── Build order items (snapshot prices, images, agent/association/restaurant assignments) ──
        const orderItems = cart.items.map((item, idx) => {
            const p = item.product;
            const agentIds = p.agentId ? [p.agentId] : (p.assignedAgents || []);

            // Snapshot the first image at order time
            const firstImage =
                (Array.isArray(p.images) && p.images.length > 0)
                    ? p.images[0]
                    : (p.image || null);

            const productLocs = (Array.isArray(value.itemLocations) ? value.itemLocations : []).find(l =>
                String(l.productId || l.product || l._id) === String(p._id)
            ) || {};

            const rawDelivery = productLocs.deliveryLocation || item.deliveryLocation;
            const hasRawDelivery = rawDelivery && (rawDelivery.lat != null || rawDelivery.latitude != null) && (rawDelivery.lng != null || rawDelivery.longitude != null);

            const itemDelivery = hasRawDelivery
                ? {
                    lat: Number(rawDelivery.lat ?? rawDelivery.latitude),
                    lng: Number(rawDelivery.lng ?? rawDelivery.longitude),
                    address: rawDelivery.address || rawDelivery.streetName || ''
                }
                : value.deliveryLocation;

            // ── Pickup location resolution ──────────────────────────────────────
            // Priority: explicit itemLocations.pickupLocation → product pickup (chosen by agent) → restaurant pickup → association pickup
            let itemPickup = productLocs.pickupLocation || null;
            const assocId = p.associationId?.toString();
            const restId = p.restaurantId?.toString();

            if (!itemPickup) {
                if (p.pickupLocation && (p.pickupLocation.lat != null || p.pickupLocation.latitude != null)) {
                    // Highest priority: Product's pickup location set by the Agent
                    itemPickup = {
                        lat: Number(p.pickupLocation.lat ?? p.pickupLocation.latitude),
                        lng: Number(p.pickupLocation.lng ?? p.pickupLocation.longitude),
                        address: p.pickupLocation.address || '',
                    };
                } else if (restId && restaurantMap[restId]?.pickupLocation?.lat != null) {
                    const rp = restaurantMap[restId].pickupLocation;
                    itemPickup = { lat: rp.lat, lng: rp.lng, address: rp.address || '' };
                } else if (assocId && associationMap[assocId]?.pickupLocation?.lat != null) {
                    const ap = associationMap[assocId].pickupLocation;
                    itemPickup = { lat: ap.lat, lng: ap.lng, address: ap.address || '' };
                } else {
                    itemPickup = { lat: null, lng: null, address: '' };
                }
            }

            const assocName = assocId ? (associationMap[assocId]?.name || null) : null;
            const restName = restId ? (restaurantMap[restId]?.name || null) : null;

            const addonsTotal = (item.selectedAddons || []).reduce((sum, a) => sum + (Number(a.price) || 0), 0);
            const unitPrice = item.priceAtAdd;
            const itemSubtotal = (unitPrice + addonsTotal) * item.quantity;

            return {
                product: p._id,
                name: p.name,
                itemIndex: idx + 1,
                price: unitPrice,
                quantity: item.quantity,
                subtotal: itemSubtotal,
                selectedAddons: item.selectedAddons || [],
                addonsTotal,
                productImage: firstImage,
                agentIds,
                associationId: assocId ? p.associationId : null,
                associationName: assocName,
                restaurantId: restId ? p.restaurantId : null,
                restaurantName: restName,
                requiredVehicleTypeId: p.requiredVehicleTypeId || (restId && restaurantMap[restId]?.requiredVehicleTypeId) || null,
                requiredVehicleTypeName: p.requiredVehicleTypeName || (restId && restaurantMap[restId]?.requiredVehicleTypeName) || null,
                // Internal grouping helpers (stripped before saving)
                _primaryAgent: p.agentId || (restId && restaurantMap[restId]?.agentId?.toString()) || (p.assignedAgents?.[0]?.toString() || null),
                _primaryAgentName: p.agentName || (restId && restaurantMap[restId]?.agentName) || null,
                _associationId: assocId || null,
                _associationName: assocName,
                _restaurantId: restId || null,
                _restaurantName: restName,
                deliveryLocation: itemDelivery,
                pickupLocation: itemPickup,
            };
        });

        // ── Group items by association first, restaurant second, then by agent ──────────────────────
        // Association products → grouped by associationId (key: 'assoc_<id>')
        // Restaurant products  → grouped by restaurantId  (key: 'rest_<id>')
        // Regular agent products → grouped by agentId     (key: 'agent_<id>' or '__noAgent__')
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
                    restaurantId: null,
                    restaurantName: null,
                };
            } else if (item._restaurantId) {
                key = `rest_${item._restaurantId}`;
                groupMeta = {
                    agentId: item._primaryAgent || null,
                    agentName: item._primaryAgentName || null,
                    associationId: null,
                    associationName: null,
                    restaurantId: item._restaurantId,
                    restaurantName: item._restaurantName,
                };
            } else {
                key = item._primaryAgent ? `agent_${item._primaryAgent}` : '__noAgent__';
                groupMeta = {
                    agentId: item._primaryAgent,
                    agentName: item._primaryAgentName,
                    associationId: null,
                    associationName: null,
                    restaurantId: null,
                    restaurantName: null,
                };
            }
            if (!agentGroups[key]) {
                agentGroups[key] = { ...groupMeta, items: [] };
            }
            agentGroups[key].items.push(item);
        }

        // ── Shared group ID so the rep can fetch all sub-orders ──────────────────
        const parentGroupId = randomUUID();

        // ── Ensure all agentGroups have real agent names (never null or raw ObjectIds) ──
        for (const group of Object.values(agentGroups)) {
            if (group.agentId && (!group.agentName || /^[0-9a-fA-F]{24}$/.test(String(group.agentName).trim()))) {
                try {
                    const agentUser = await User.findById(group.agentId).select('firstName lastName storeName fullName').lean();
                    if (agentUser) {
                        group.agentName = (agentUser.storeName && agentUser.storeName.trim()) ||
                            `${agentUser.firstName || ''} ${agentUser.lastName || ''}`.trim() ||
                            agentUser.fullName ||
                            null;
                    }
                } catch (_) { }
            }
        }

        const userInfo = {
            firstName: user?.firstName || '',
            lastName: user?.lastName || '',
            email: user?.email || '',
            phone: user?.phone || '',
            profileImage: user?.profileImage || null,
        };

        // ── Create one StoreOrder per group ───────────────────────────────────────
        const sharedStoreOrderId = await getNextStoreOrderId();
        const createdOrders = [];
        const groupEntries = Object.values(agentGroups);
        for (let groupIdx = 0; groupIdx < groupEntries.length; groupIdx++) {
            const group = groupEntries[groupIdx];
            const groupItems = group.items.map(
                ({ _primaryAgent, _primaryAgentName, _associationId, _associationName, _restaurantId, _restaurantName, ...rest }) => rest
            );
            const involvedAgentsSet = new Set();
            groupItems.forEach(i => i.agentIds.forEach(id => involvedAgentsSet.add(id)));

            const groupTotal = groupItems.reduce((sum, i) => sum + i.subtotal, 0);

            // Pick highest required vehicle type among group items
            const highestItemVeh = getHighestVehicleType(groupItems);
            const reqTypeId = highestItemVeh.requiredVehicleTypeId;
            const reqTypeName = highestItemVeh.requiredVehicleTypeName;

            // ── Delivery price in whole integer fils (down to 1 fil precision)
            let normDeliveryPrice = value.deliveryPrice != null ? Math.round(Number(value.deliveryPrice)) : 0;

            const subOrderId = groupIdx === 0 ? sharedStoreOrderId : await getNextStoreOrderId();

            const subOrder = new StoreOrder({
                orderId: subOrderId,
                storeOrderId: sharedStoreOrderId,
                subOrderIndex: groupIdx + 1,
                parentGroupId,
                agentId: group.agentId,
                agentName: group.agentName,
                associationId: group.associationId || null,
                associationName: group.associationName || null,
                restaurantId: group.restaurantId || null,
                restaurantName: group.restaurantName || null,
                requiredVehicleTypeId: reqTypeId,
                requiredVehicleTypeName: reqTypeName,
                userId,
                clientId: userId,
                userInfo,
                items: groupItems,
                totalPrice: Math.round(groupTotal),
                deliveryPrice: normDeliveryPrice,
                totalDeliveryPrice: normDeliveryPrice,
                deliveryDistanceMeters: value.deliveryDistanceMeters,
                notes: value.notes,
                paymentMethod: value.paymentMethod,
                deliveryLocation: value.deliveryLocation,   // checkout-level fallback
                involvedAgents: Array.from(involvedAgentsSet),
            });
            await subOrder.save(session ? { session } : undefined);
            createdOrders.push(subOrder);
        }

        // ── Clear cart after successful checkout ──────────────────────────────────
        await Cart.findOneAndDelete({ userId }, session ? { session } : undefined);

        // ── Commit transaction if active ──────────────────────────────────────────
        if (inTransaction && session) {
            await session.commitTransaction();
            await session.endSession();
            session = null;
            inTransaction = false;
        }

        res.status(201).json({
            message: 'Order placed successfully',
            parentGroupId,
            orderCount: createdOrders.length,
            orders: createdOrders,
        });
    } catch (err) {
        console.error('Checkout Error:', err);
        if (inTransaction && session) {
            try {
                await session.abortTransaction();
                await session.endSession();
            } catch (_) { }
        } else if (reservedItems.length > 0) {
            // Automatic compensating rollback if saving orders failed in standalone mode
            try {
                await restoreProductStockAtomically(reservedItems);
            } catch (_) { }
        }
        return res.status(500).json({ message: 'Internal Server Error', error: err.message });
    }
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
    const enriched = await Promise.all(orders.map(o => enrichOrderImages(req, o)));

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
    } else if (mongoose.Types.ObjectId.isValid(idParam)) {
        const single = await StoreOrder.findById(idParam);
        if (!single) return res.status(404).json({ message: 'Order not found' });
        if (single.parentGroupId) {
            const orders = await StoreOrder.find({ parentGroupId: single.parentGroupId }).sort({ storeOrderId: 1 });
            const grouped = groupStoreOrders(orders);
            order = grouped[0] || single;
        } else {
            order = single;
        }
    } else if (!isNaN(Number(idParam))) {
        const numId = Number(idParam);
        let orders = await StoreOrder.find({
            $or: [
                { storeOrderId: numId },
                { orderId: numId },
            ]
        }).sort({ storeOrderId: 1, subOrderIndex: 1 });
        if (!orders.length) return res.status(404).json({ message: 'Order not found' });
        const firstWithGroup = orders.find(o => o.parentGroupId);
        if (firstWithGroup) {
            orders = await StoreOrder.find({ parentGroupId: firstWithGroup.parentGroupId }).sort({ storeOrderId: 1, subOrderIndex: 1 });
        }
        const grouped = groupStoreOrders(orders);
        order = grouped[0];
    } else {
        return res.status(400).json({ message: 'Invalid order ID format' });
    }

    const userId = req.user.id;
    const isAdmin = req.user.isAdmin;
    const isAgent = req.user.userType === 'Agent';
    const isRepresentative = req.user.userType === 'Representative';

    if (isAdmin) {
        // Admin sees all
    } else if (isRepresentative) {
        // Representative sees all sub-orders in the group
    } else if (isAgent) {
        // Agent only sees order/items if they are involved
        if (order.subOrders && order.subOrders.length > 0) {
            const agentSubs = order.subOrders.filter(s =>
                String(s.agentId) === String(userId) ||
                (Array.isArray(s.involvedAgents) && s.involvedAgents.some(a => String(a) === String(userId)))
            );
            if (agentSubs.length > 0) {
                // Return agent's sub-order only
                order = agentSubs.length === 1 ? agentSubs[0] : groupStoreOrders(agentSubs)[0];
            } else if (!order.involvedAgents?.some(a => String(a) === String(userId)) && String(order.agentId) !== String(userId)) {
                return res.status(403).json({ message: 'Access denied. You are not assigned to products in this order.' });
            }
        } else if (!order.involvedAgents?.some(a => String(a) === String(userId)) && String(order.agentId) !== String(userId)) {
            return res.status(403).json({ message: 'Access denied. You are not assigned to products in this order.' });
        }
    } else {
        // Normal user only sees their own order
        if (String(order.userId) !== String(userId)) {
            return res.status(403).json({ message: 'Access denied' });
        }
    }

    const enriched = await enrichOrderImages(req, order);
    try {
        const orderIdentifier = order.parentGroupId || order._id || order.storeOrderId || order.orderId || idParam;
        const trackData = await BusinessOrderTracker.getOrderTrack(orderIdentifier);
        if (trackData && typeof enriched === 'object' && enriched !== null) {
            enriched.track = trackData;
        }
    } catch (_) {}
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

    const enriched = await Promise.all(orders.map(o => enrichOrderImages(req, o)));

    let groupDelivery = enriched.length > 0 ? Math.round(Number(enriched[0].deliveryPrice || 0)) : 0;

    let trackData = null;
    try {
        trackData = await BusinessOrderTracker.getOrderTrack(groupId);
    } catch (_) {}

    res.json({
        parentGroupId: groupId,
        orderCount: enriched.length,
        totalPrice: Math.round(enriched.reduce((s, o) => s + (o.totalPrice || 0), 0)),
        deliveryPrice: groupDelivery,
        deliveryDistanceMeters: enriched.length > 0 ? (enriched[0].deliveryDistanceMeters || 0) : 0,
        orders: enriched,
        track: trackData,
    });
};

/**
 * @desc   Admin/Agent: Get all store orders
 * @route  GET /api/store/orders
 * @query  page, limit, status, userId, search,
 *         date      (YYYY-MM-DD)  — exact calendar day filter
 *         dateFrom  (YYYY-MM-DD)  — range start (inclusive)
 *         dateTo    (YYYY-MM-DD)  — range end   (inclusive)
 *         agentId   — filter sub-orders by a specific agent
 *         groupId   — filter by parentGroupId
 */
const getAllOrders = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,
            status,
            orderStatus,
            userId: filterUserId,
            search,
            date,       // exact day e.g. "2026-05-10"
            dateTime,   // ISO date string e.g. "2026-08-15T00:00:00.000Z"
            dateFrom,   // range start
            dateTo,     // range end
            agentId,    // filter by specific agent
            groupId,    // filter by parentGroupId
        } = req.query;

        const isAdmin = req.user?.isAdmin;
        const isAgent = req.user?.userType === 'Agent';

        const filter = {};

        // ── Status filtering ──
        if (orderStatus !== undefined && orderStatus !== null && orderStatus !== '') {
            const numStatus = Number(orderStatus);
            if (numStatus === 0) {
                filter.status = 'pending';
            } else if (numStatus === 1) {
                filter.status = { $in: ['confirmed', 'processing', 'shipped'] };
            } else if (numStatus === 2) {
                filter.status = { $in: ['cancelled', 'return_cancelled'] };
            } else if (numStatus === 3) {
                filter.status = { $in: ['delivered', 'completed'] };
            } else if (numStatus === 4) {
                filter.status = 'review';
            } else if (numStatus === 5) {
                filter.status = 'delayed';
            } else if (numStatus === 6) {
                filter.status = { $in: ['return_pending', 'return_accepted', 'return_delivering'] };
            } else if (numStatus === 7) {
                filter.status = 'returned';
            }
        } else if (status && status.toLowerCase() !== 'all') {
            const s = status.toLowerCase();
            if (s === 'pending' || s === 'waiting') {
                filter.status = 'pending';
            } else if (s === 'review') {
                filter.status = 'review';
            } else if (s === 'delayed') {
                filter.status = 'delayed';
            } else if (s === 'confirmed' || s === 'processing' || s === 'shipped' || s === 'accepted' || s === 'inprogress') {
                filter.status = { $in: ['confirmed', 'processing', 'shipped'] };
            } else if (s === 'completed' || s === 'delivered') {
                filter.status = { $in: ['delivered', 'completed'] };
            } else if (s === 'cancelled') {
                filter.status = { $in: ['cancelled', 'return_cancelled'] };
            } else if (s === 'return_pending' || s === 'returning' || s === 'returns') {
                filter.status = { $in: ['return_pending', 'return_accepted', 'return_delivering'] };
            } else if (s === 'returned') {
                filter.status = 'returned';
            } else {
                const statuses = status.split(',').map(st => st.trim()).filter(Boolean);
                filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
            }
        }

        // ── Business orders ONLY (exclude delivery orders) ──
        filter.$and = filter.$and || [];
        filter.$and.push({
            $or: [
                { isBusinessOrder: true },
                { orderCategory: 'business' },
                { 'items.0': { $exists: true } },
            ]
        });

        if (filterUserId) filter.userId = filterUserId;
        if (groupId) filter.parentGroupId = groupId;

        if (agentId) {
            filter.$and.push({
                $or: [{ agentId: String(agentId) }, { involvedAgents: String(agentId) }, { 'items.agentIds': String(agentId) }]
            });
        } else if (isAgent && !isAdmin) {
            // Agent only sees their own sub-orders
            filter.$and.push({
                $or: [{ agentId: String(req.user.id) }, { involvedAgents: String(req.user.id) }, { 'items.agentIds': String(req.user.id) }]
            });
        }

        if (search) {
            filter.$or = [
                { 'userInfo.firstName': { $regex: search, $options: 'i' } },
                { 'userInfo.lastName': { $regex: search, $options: 'i' } },
                { 'userInfo.email': { $regex: search, $options: 'i' } },
                { 'items.name': { $regex: search, $options: 'i' } },
            ];
        }

        // ── Date filtering ──
        const targetDate = dateTime || date;
        if (targetDate) {
            const dayStart = new Date(targetDate);
            if (!isNaN(dayStart.getTime())) {
                dayStart.setUTCHours(0, 0, 0, 0);
                const dayEnd = new Date(targetDate);
                dayEnd.setUTCHours(23, 59, 59, 999);
                filter.createdAt = { $gte: dayStart, $lte: dayEnd };
            }
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
        // ───────────────────────────────────────────────────────────────────────

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
        const enriched = await Promise.all(displayOrders.map(o => enrichOrderImages(req, o)));

        return res.json({
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.ceil(total / limitNum),
            totalRevenue,
            dateFilter: date || (dateFrom || dateTo ? { from: dateFrom, to: dateTo } : null),
            orders: enriched,
        });
    } catch (err) {
        console.error('[getAllOrders Error]', err.message);
        return res.status(500).json({ message: 'Internal server error', error: err.message });
    }
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
            if (value.status === 'cancelled' && order.status !== 'cancelled' && Array.isArray(order.items) && order.items.length > 0) {
                await restoreProductStockAtomically(order.items);
            }
            order.status = value.status;
            if (value.status === 'delivered' || value.status === 'completed') {
                order.deliveredAt = order.deliveredAt || new Date();
            }
            await order.save();
        }
        return res.json({
            message: 'Group order status updated',
            storeOrderId: orders[0].storeOrderId,
            status: value.status,
            updatedAt: orders[0].updatedAt,
        });
    }

    let order;
    if (mongoose.Types.ObjectId.isValid(idParam)) {
        order = await StoreOrder.findById(idParam);
    } else if (!isNaN(Number(idParam))) {
        order = await StoreOrder.findOne({
            $or: [
                { storeOrderId: Number(idParam) },
                { orderId: Number(idParam) },
            ]
        });
    } else {
        return res.status(400).json({ message: 'Invalid order ID format' });
    }

    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (isAgent && !isAdmin) {
        // Agent can only update their own sub-order
        if (order.agentId !== req.user.id && !order.involvedAgents.includes(req.user.id)) {
            return res.status(403).json({ message: 'Access denied. You are not assigned to this order.' });
        }
    }

    if (value.status === 'cancelled' && order.status !== 'cancelled' && Array.isArray(order.items) && order.items.length > 0) {
        await restoreProductStockAtomically(order.items);
    }
    order.status = value.status;
    if (value.status === 'delivered' || value.status === 'completed') {
        order.deliveredAt = order.deliveredAt || new Date();
    }
    await order.save();

    // ─── Fire-and-forget: check target reward, process wallet, & send email when store order is delivered ───
    if (value.status === 'delivered' || value.status === 'completed') {
        let isGroupAllDelivered = false;

        if (order.parentGroupId) {
            // الحالة الطبيعية: نجيب كل sub-orders بنفس parentGroupId
            const groupSubs = await StoreOrder.find({ parentGroupId: order.parentGroupId });
            isGroupAllDelivered = groupSubs.length > 0
                && groupSubs.every(s => (s.status === 'delivered' || s.status === 'completed') && (!Array.isArray(s.items) || s.items.length === 0 || s.items.every(i => i.status === 'delivered' || i.isDelivered === true)));
        } else if (order.storeOrderId) {
            // fallback: لو مفيش parentGroupId، نجيب كل sub-orders بنفس storeOrderId
            const groupSubs = await StoreOrder.find({ storeOrderId: order.storeOrderId });
            isGroupAllDelivered = groupSubs.length > 0
                && groupSubs.every(s => (s.status === 'delivered' || s.status === 'completed') && (!Array.isArray(s.items) || s.items.length === 0 || s.items.every(i => i.status === 'delivered' || i.isDelivered === true)));
        } else {
            // أوردر منفرد بدون grouping
            isGroupAllDelivered = !Array.isArray(order.items) || order.items.length === 0 || order.items.every(i => i.status === 'delivered' || i.isDelivered === true);
        }

        if (isGroupAllDelivered) {
            if (order.representativeId) {
                const { processOrderCompletionWallet } = require('../middlewares/Wallet');
                await processOrderCompletionWallet(order).catch((e) => console.error('[storeOrderController] Wallet error:', e.message));
                checkAndRewardTarget(order.representativeId).catch(() => { });
            }

            const { sendBusinessOrderCompletionEmail, dispatchBackgroundEmail } = require('../services/emailService');
            // نمرر parentGroupId ليتم جلب جميع الـ sub-orders من DB مع صورها الخاصة
            const emailRef = order.parentGroupId || order.storeOrderId || order._id;
            dispatchBackgroundEmail(async () => {
                await sendBusinessOrderCompletionEmail(emailRef);
            });
        }
    }

    // ─── Emit real-time status change via Socket.IO ───────────────────────────
    try {
        const io = req.app.get('io');
        if (io) {
            const sid = order.storeOrderId || order.orderId || idParam;
            const room = `order:${sid}`;
            const payload = {
                orderId: sid,
                storeOrderId: order.storeOrderId,
                status: order.status,
                message: `Store order status changed to ${order.status}`,
            };
            io.to(room).emit('order:status_changed', payload);
            if (order.clientId || order.userId) {
                io.to(`user:${order.clientId || order.userId}`).emit('order:status_changed', payload);
            }
        }
    } catch (socketErr) {
        console.error('[Socket.IO] Failed to emit store order status_changed:', socketErr.message);
    }

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
    const idParam = req.params.id;
    let order;
    if (mongoose.Types.ObjectId.isValid(idParam)) {
        order = await StoreOrder.findById(idParam);
    } else if (!isNaN(Number(idParam))) {
        order = await StoreOrder.findOne({
            $or: [
                { storeOrderId: Number(idParam) },
                { orderId: Number(idParam) },
            ]
        });
    }
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.userId !== userId) return res.status(403).json({ message: 'Access denied' });
    if (order.status !== 'pending') {
        return res.status(400).json({ message: `Cannot cancel an order with status: ${order.status}` });
    }

    // ── Restore reserved product stock atomically ──
    if (order.status !== 'cancelled' && Array.isArray(order.items) && order.items.length > 0) {
        await restoreProductStockAtomically(order.items);
    }

    const oldRepId = order.representativeId;
    order.status = 'cancelled';
    await order.save();

    if (oldRepId) {
        try {
            const { clearRepCurrentOrder, invalidateLiveDashboard } = require('../redis/hrRedis');
            await clearRepCurrentOrder(oldRepId);
            await invalidateLiveDashboard();
        } catch (_) { }
    }

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

    // ── Restore reserved product stock atomically for all sub-orders in group ──
    for (const o of orders) {
        if (o.status !== 'cancelled' && Array.isArray(o.items) && o.items.length > 0) {
            await restoreProductStockAtomically(o.items);
        }
    }

    await StoreOrder.updateMany({ parentGroupId: groupId, userId }, { $set: { status: 'cancelled' } });

    res.json({ message: 'All sub-orders cancelled', parentGroupId: groupId, cancelledCount: orders.length });
};

/**
 * @desc   Set delivery location for a specific item in a cart
 * @route  PATCH /api/store/cart/:productId/delivery-location
 */

// ─── Representative Controllers ───────────────────────────────────────────────

/**
 * @desc   Representative: List all pending store orders (available to pick up)
 * @route  GET /api/store/orders/representative/pending
 * @query  status (optional, comma-separated: pending,confirmed,processing,shipped,delivered,cancelled)
 * @access Representative / Admin
 */
const getRepresentativeOrders = async (req, res) => {
    try {
        const { status, page = 1, limit = 50 } = req.query;

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
        const skip = (pageNum - 1) * limitNum;

        // Check if representative turned off business orders
        let repUser = null;
        try {
            const token = req.user?.id ? null : (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.substring(7) : req.headers.token);
            const jwt = require('jsonwebtoken');
            const userId = req.user?.id || (token ? jwt.verify(token, process.env.JWT_SECRET)?.id : null);
            if (userId) {
                const { User } = require('../middlewares/User');
                repUser = await User.findById(userId).select('preferredOrderTypes vehicleTypeId vehicleTypeName').lean();
                if (repUser) {
                    if (Array.isArray(repUser.preferredOrderTypes) && repUser.preferredOrderTypes.length > 0) {
                        const hasBusiness = repUser.preferredOrderTypes.some(t => t.toLowerCase() === 'business');
                        if (!hasBusiness) {
                            return res.json({
                                page: pageNum,
                                limit: limitNum,
                                total: 0,
                                totalPages: 0,
                                orders: [],
                            });
                        }
                    }

                    // Auto-resolve missing vehicleTypeName or vehicleTypeId if one exists
                    if (repUser.vehicleTypeId && !repUser.vehicleTypeName) {
                        try {
                            const { VehicleType } = require('../middlewares/VehicleType');
                            const vt = await VehicleType.findById(repUser.vehicleTypeId).lean();
                            if (vt) repUser.vehicleTypeName = vt.name_ar || vt.name_en || null;
                        } catch (_) { }
                    }
                }
            }
        } catch (_) { }

        const filter = {};
        if (status) {
            const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
            if (statuses.length === 1 && statuses[0] === 'pending') {
                filter.status = { $in: ['pending', 'confirmed', 'processing', 'return_pending'] };
            } else {
                filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
            }
        } else {
            // Default: show pending/available orders (unassigned), including return_pending
            filter.status = { $in: ['pending', 'confirmed', 'processing', 'return_pending'] };
        }

        // Only return orders that are unassigned to any representative
        filter.$or = [
            { representativeId: null },
            { representativeId: { $exists: false } },
            { representativeId: '' }
        ];

        const [orders, total] = await Promise.all([
            StoreOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
            StoreOrder.countDocuments(filter),
        ]);

        const grouped = groupStoreOrders(orders);

        let finalGrouped = grouped;
        if (repUser && (repUser.vehicleTypeId || repUser.vehicleTypeName)) {
            const repMeta = getVehicleMeta(repUser.vehicleTypeName);
            finalGrouped = grouped.filter(o => {
                const candidates = [
                    { requiredVehicleTypeId: o.requiredVehicleTypeId, requiredVehicleTypeName: o.requiredVehicleTypeName },
                    ...(o.items || []),
                    ...(o.subOrders || []).flatMap(s => [
                        { requiredVehicleTypeId: s.requiredVehicleTypeId, requiredVehicleTypeName: s.requiredVehicleTypeName },
                        ...(s.items || [])
                    ])
                ];
                const highestReq = getHighestVehicleType(candidates);
                const reqTypeId = highestReq.requiredVehicleTypeId || o.requiredVehicleTypeId;
                const reqTypeName = highestReq.requiredVehicleTypeName || o.requiredVehicleTypeName;

                // No vehicle restriction on any product in this order -> available to all representatives
                if (!reqTypeId && !reqTypeName) return true;

                const orderMeta = getVehicleMeta(reqTypeName);

                // 1. Direct MongoDB ID match if both IDs are present
                if (reqTypeId && repUser.vehicleTypeId && reqTypeId.toString() === repUser.vehicleTypeId.toString()) {
                    return true;
                }

                // 2. Canonical key match (e.g. SEDAN === SEDAN, LARGE_HALF_LORRY === LARGE_HALF_LORRY)
                if (orderMeta.canonicalKey && repMeta.canonicalKey) {
                    return orderMeta.canonicalKey === repMeta.canonicalKey;
                }

                // 3. Normalized Arabic string match
                if (reqTypeName && repUser.vehicleTypeName) {
                    return normalizeArabic(reqTypeName) === normalizeArabic(repUser.vehicleTypeName);
                }

                return false;
            });
        }

        const enriched = await Promise.all(finalGrouped.map(o => enrichOrder(o)));

        res.json({
            page: pageNum,
            limit: limitNum,
            total: finalGrouped.length,
            totalPages: Math.ceil(finalGrouped.length / limitNum),
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

        const pageNum = Math.max(1, parseInt(page));
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
 * @body   {} (empty — representativeId taken from JWT)
 * @access Representative
 */
const acceptStoreOrder = async (req, res) => {
    try {
        const { id } = req.params;
        const repId = req.user.id;

        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
        const isValidId = isUuid || mongoose.Types.ObjectId.isValid(id) || !isNaN(Number(id));
        if (!isValidId) {
            return res.status(400).json({ message: 'Invalid order ID format' });
        }

        const ordersToUpdate = await findStoreOrdersByIdentifier(id, true);
        if (!ordersToUpdate.length) return res.status(404).json({ message: 'Order not found' });

        if (ordersToUpdate.some(o => o.status !== 'pending' && o.status !== 'return_pending')) {
            return res.status(409).json({
                message: `Cannot accept order. Some orders are not pending or return_pending.`,
            });
        }

        // ─── التحقق الشامل من الأهلية والشيفت والحضور والانصراف قبل قبول الطلب ─────
        if (repId) {
            const { checkRepCanAcceptOrder } = require('../utils/orderAcceptanceGuard');
            const guardResult = await checkRepCanAcceptOrder(repId);
            if (!guardResult.canAccept) {
                return res.status(guardResult.statusCode || 403).json({
                    message: guardResult.message,
                    code: guardResult.code,
                });
            }

            // ─── التحقق من توافق نوع مركبة المندوب مع المتطلب الأكبر للطلب ───────────
            try {
                const { User } = require('../middlewares/User');
                const repUser = await User.findById(repId).select('vehicleTypeId vehicleTypeName').lean();
                if (repUser && (repUser.vehicleTypeId || repUser.vehicleTypeName)) {
                    const candidates = [
                        ...ordersToUpdate.map(o => ({ requiredVehicleTypeId: o.requiredVehicleTypeId, requiredVehicleTypeName: o.requiredVehicleTypeName })),
                        ...ordersToUpdate.flatMap(o => o.items || [])
                    ];
                    const highestReq = getHighestVehicleType(candidates);
                    const reqTypeId = highestReq.requiredVehicleTypeId;
                    const reqTypeName = highestReq.requiredVehicleTypeName;

                    if (reqTypeId || reqTypeName) {
                        const orderMeta = getVehicleMeta(reqTypeName);
                        const repMeta = getVehicleMeta(repUser.vehicleTypeName);

                        const idMatch = reqTypeId && repUser.vehicleTypeId && reqTypeId.toString() === repUser.vehicleTypeId.toString();
                        const keyMatch = orderMeta.canonicalKey && repMeta.canonicalKey && orderMeta.canonicalKey === repMeta.canonicalKey;
                        const nameMatch = reqTypeName && repUser.vehicleTypeName && normalizeArabic(reqTypeName) === normalizeArabic(repUser.vehicleTypeName);

                        if (!idMatch && !keyMatch && !nameMatch) {
                            return res.status(403).json({
                                message: `هذا الطلب يتطلب مركبة من نوع (${highestReq.requiredVehicleTypeName || 'أكبر'})، ولا يتطابق مع نوع مركبتك المسجلة (${repUser.vehicleTypeName || 'غير محدد'}).`,
                                code: 'VEHICLE_TYPE_MISMATCH',
                            });
                        }
                    }
                }
            } catch (_) { }
        }

        const now = new Date();
        const isReturn = ordersToUpdate.some(o => o.status === 'return_pending' || o.isReturnOrder === true);
        for (const order of ordersToUpdate) {
            order.status = (order.status === 'return_pending' || order.isReturnOrder) ? 'return_accepted' : 'confirmed';
            order.representativeId = repId;
            order.acceptedAt = now;
            await order.save();
        }

        try {
            const { setRepCurrentOrder, invalidateLiveDashboard } = require('../redis/hrRedis');
            await setRepCurrentOrder(repId, {
                orderId: String(ordersToUpdate[0].storeOrderId || ordersToUpdate[0]._id),
                status: isReturn ? 'return_accepted' : 'confirmed',
                totalAmount: ordersToUpdate[0].totalPrice,
            });
            await invalidateLiveDashboard();
        } catch (_) { }

        const grouped = groupStoreOrders(ordersToUpdate);
        const order = grouped[0];
        const enriched = await enrichOrder(order);

        // ─── FCM: notify client that order is confirmed or return accepted ───────────────────
        if (isReturn) {
            notifyClient(
                order.userId,
                '🔄 تم قبول طلب المرتجع',
                'تم قبول طلب المرتجع من قِبَل المندوب وسيصل إليك قريباً لاستلام المنتجات',
                { type: 'store_order_return_accepted', storeOrderId: String(order.storeOrderId), orderId: String(order._id) },
            ).catch(() => { });
        } else {
            notifyClient(
                order.userId,
                '📦 تم تأكيد طلبك',
                'تم قبول طلبك من قِبَل المندوب وسيتم تجهيزه قريباً',
                { type: 'store_order_confirmed', storeOrderId: String(order.storeOrderId), orderId: String(order._id) },
            ).catch(() => { });
        }

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
        const reason = req.body.reason || 'المندوب ألغى المهمة';

        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
        const isValidId = isUuid || mongoose.Types.ObjectId.isValid(id) || !isNaN(Number(id));
        if (!isValidId) {
            return res.status(400).json({ message: 'Invalid order ID format' });
        }

        const ordersToUpdate = await findStoreOrdersByIdentifier(id, true);
        if (!ordersToUpdate.length) return res.status(404).json({ message: 'Order not found' });

        // ─── فحص مهلة الإلغاء وخصم الرسوم من محفظة المندوب إذا ألغى بعد انقضاء المهلة ───
        let cancellationFeeApplied = false;
        let cancellationFeeFils = 0;
        const firstOrder = ordersToUpdate[0];
        const acceptedAtTime = firstOrder?.acceptedAt;

        if (acceptedAtTime && repId) {
            try {
                const { getOrCreatePricing } = require('../middlewares/Pricing');
                const pricing = await getOrCreatePricing();
                const cancelMinutes = pricing.clientCancellationTimerMinutes ?? pricing.arrivalTimerMinutes ?? 10;
                const timerMs = cancelMinutes * 60 * 1000;
                const elapsedMs = Date.now() - new Date(acceptedAtTime).getTime();

                if (elapsedMs >= timerMs && pricing.cancellationFeeForClient > 0) {
                    const { debitWalletAllowNegative } = require('../middlewares/Wallet');
                    const refId = String(firstOrder.storeOrderId || firstOrder._id || id);
                    try {
                        await debitWalletAllowNegative({
                            userId: repId,
                            amountFils: pricing.cancellationFeeForClient,
                            type: 'cancellation_fee',
                            description: `رسوم إلغاء قبول طلب البيزنس #${refId} بعد تجاوز مهلة ${cancelMinutes} دقيقة`,
                            refId,
                            performedBy: 'system',
                        });
                        cancellationFeeApplied = true;
                        cancellationFeeFils = pricing.cancellationFeeForClient;
                        console.log(`[releaseStoreOrder] تم خصم رسوم إلغاء (${cancellationFeeFils} فلس) من المندوب ${repId} لتجاوز المهلة`);
                    } catch (walletErr) {
                        console.error(`[releaseStoreOrder] فشل خصم رسوم الإلغاء من محفظة المندوب: ${walletErr.message}`);
                    }
                }
            } catch (pricingErr) {
                console.error(`[releaseStoreOrder] خطأ في جلب إعدادات التسعير: ${pricingErr.message}`);
            }
        }

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
            order.acceptedAt = null;
            order.cancellationReason = reason;
            await order.save();
        }

        try {
            const { clearRepCurrentOrder, invalidateLiveDashboard } = require('../redis/hrRedis');
            await clearRepCurrentOrder(repId);
            await invalidateLiveDashboard();
        } catch (_) { }

        const grouped = groupStoreOrders(ordersToUpdate);
        const order = grouped[0];
        const enriched = await enrichOrder(order);

        if (cancellationFeeApplied && repId) {
            const feeKd = (cancellationFeeFils / 1000).toFixed(3);
            notifyClient(
                repId,
                '⚠️ خصم رسوم إلغاء الطلب',
                `تم خصم ${feeKd} د.ك من محفظتك كرسوم لإلغاء طلب البيزنس بعد انقضاء مهلة الإلغاء المحددة.`,
                { type: 'wallet_debit', orderId: String(order.storeOrderId || id), feeFils: String(cancellationFeeFils) },
            ).catch(() => { });
        }

        // 🔔 FCM: notify client that order is returned to pending (searching for representative)
        notifyClient(
            order.userId,
            'جاري البحث عن مندوب جديد',
            'المندوب اعتذر عن الطلب وجاري إسناده لمندوب آخر',
            { type: 'store_order_released', storeOrderId: String(order.storeOrderId), orderId: String(order._id) },
        ).catch(() => { });

        res.json({
            succeeded: true,
            message: cancellationFeeApplied
                ? `تم إلغاء قبول الطلب وعاد للانتظار، وتم خصم ${(cancellationFeeFils / 1000).toFixed(3)} د.ك كرسوم إلغاء لتجاوز المهلة.`
                : 'Order released back to pending successfully',
            cancellationFeeApplied,
            cancellationFeeFils,
            cancellationFeeKD: cancellationFeeFils / 1000,
            ...enriched,
        });
    } catch (err) {
        console.error('[releaseStoreOrder]', err.message);
        res.status(500).json({ message: 'Internal server error' });
    }
};

/**
 * @desc   Representative: Update store order status
 *         Allowed transitions: confirmed → processing → shipped → delivered
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

        const ALLOWED_STATUSES = ['processing', 'shipped', 'delivered', 'cancelled', 'return_delivering', 'returned'];
        if (!status || !ALLOWED_STATUSES.includes(status)) {
            return res.status(400).json({
                message: `status must be one of: ${ALLOWED_STATUSES.join(', ')}`,
            });
        }

        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
        const isValidId = isUuid || mongoose.Types.ObjectId.isValid(id) || !isNaN(Number(id));
        if (!isValidId) {
            return res.status(400).json({ message: 'Invalid order ID format' });
        }

        const ordersToUpdate = await findStoreOrdersByIdentifier(id, isUuid);
        if (!ordersToUpdate.length) return res.status(404).json({ message: 'Order not found' });

        const isReturnOrder = ordersToUpdate.some(o => o.isReturnOrder === true || (typeof o.status === 'string' && o.status.startsWith('return_')));
        let effectiveStatus = status;
        if (isReturnOrder) {
            if (status === 'shipped' || status === 'delivering') effectiveStatus = 'return_delivering';
            if (status === 'delivered') effectiveStatus = 'returned';
        }

        const isAdmin = req.user?.isAdmin;

        const targetProdId = req.body?.productId || req.query?.productId;
        const rawTaskId = req.body?.taskId || req.query?.taskId;
        const rawSubOrderId = req.body?.subOrderId || req.query?.subOrderId;
        const rawItemIndex = req.body?.itemIndex ?? req.query?.itemIndex ?? req.body?.index ?? req.query?.index;

        // Target the specific sub-order if multiple orders in group
        let targetOrders = ordersToUpdate;
        const deliverAll = req.body?.all === true || ((effectiveStatus === 'delivered' || effectiveStatus === 'returned') && !rawSubOrderId && !targetProdId && rawTaskId === undefined && rawItemIndex === undefined);
        if (ordersToUpdate.length > 1 && !deliverAll) {
            let matchedOrder = null;
            if (rawSubOrderId) {
                matchedOrder = ordersToUpdate.find(o => String(o._id) === String(rawSubOrderId) || String(o.storeOrderId) === String(rawSubOrderId));
            }
            if (!matchedOrder && targetProdId) {
                matchedOrder = ordersToUpdate.find(o => Array.isArray(o.items) && o.items.some(i => String(i.product || i._id) === String(targetProdId)));
            }
            if (!matchedOrder && rawTaskId !== undefined && rawTaskId !== null && rawTaskId !== '') {
                const subPart = String(rawTaskId).includes('_') ? String(rawTaskId).split('_')[0] : String(rawTaskId);
                matchedOrder = ordersToUpdate.find(o => String(o._id) === subPart || String(o.storeOrderId) === subPart || String(o.subOrderIndex) === subPart);
            }
            if (!matchedOrder) {
                matchedOrder = ordersToUpdate.find(o => {
                    if (effectiveStatus === 'delivered') {
                        return o.status !== 'delivered' || (Array.isArray(o.items) && o.items.some(i => i.status !== 'delivered' && !i.isDelivered));
                    } else if (effectiveStatus === 'returned') {
                        return o.status !== 'returned';
                    } else if (effectiveStatus === 'shipped') {
                        return o.status !== 'shipped' || (Array.isArray(o.items) && o.items.some(i => i.status !== 'shipped' && !i.isPickedUp));
                    } else if (effectiveStatus === 'return_delivering') {
                        return o.status !== 'return_delivering';
                    }
                    return true;
                });
            }
            if (matchedOrder) {
                targetOrders = [matchedOrder];
            }
        }

        for (const order of targetOrders) {
            // Security: representative can only update their own accepted orders
            if (!isAdmin && order.representativeId !== repId) {
                return res.status(403).json({
                    message: 'Access denied. You are not assigned to this order.',
                });
            }

            // Valid transitions from current status
            const VALID_TRANSITIONS = {
                confirmed: ['processing', 'shipped', 'cancelled'],
                processing: ['shipped', 'cancelled'],
                shipped: ['shipped', 'delivering', 'delivered', 'cancelled'],
                delivering: ['delivering', 'delivered', 'cancelled'],
                return_accepted: ['return_delivering', 'cancelled', 'return_cancelled'],
                return_delivering: ['returned', 'cancelled', 'return_cancelled'],
            };

            let targetItem = null;
            if (Array.isArray(order.items) && order.items.length > 0) {
                if (targetProdId) {
                    targetItem = order.items.find(i => String(i.product || i._id) === String(targetProdId));
                }
                if (!targetItem && rawTaskId !== undefined && rawTaskId !== null && rawTaskId !== '' && String(rawTaskId).includes('_')) {
                    const itemPart = parseInt(String(rawTaskId).split('_')[1], 10);
                    if (!isNaN(itemPart) && order.items[itemPart]) {
                        targetItem = order.items[itemPart];
                    }
                }
                if (!targetItem && rawItemIndex !== undefined && rawItemIndex !== null && rawItemIndex !== '') {
                    const idx = parseInt(rawItemIndex, 10);
                    if (!isNaN(idx) && order.items[idx]) {
                        targetItem = order.items[idx];
                    }
                }
                if (!targetItem && rawTaskId !== undefined && rawTaskId !== null && rawTaskId !== '') {
                    const tId = parseInt(rawTaskId, 10);
                    if (!isNaN(tId) && tId >= 1 && order.items[tId - 1]) {
                        targetItem = order.items[tId - 1];
                    }
                }
                if (!targetItem) {
                    if (status === 'delivered') {
                        targetItem = order.items.find(i => i.status !== 'delivered' && !i.isDelivered);
                    } else if (status === 'shipped') {
                        targetItem = order.items.find(i => i.status !== 'shipped' && !i.isPickedUp);
                    }
                }
            }

            if (effectiveStatus === 'returned') {
                if (order.status !== 'returned' && Array.isArray(order.items) && order.items.length > 0) {
                    await restoreProductStockAtomically(order.items);
                }
                if (Array.isArray(order.items)) {
                    order.items.forEach(i => {
                        i.status = 'returned';
                        i.isDelivered = true;
                    });
                    order.markModified('items');
                }
                order.status = 'returned';
                if (!order.returnDetails) order.returnDetails = {};
                order.returnDetails.returnDeliveredAt = new Date();
                await order.save();
            } else if (effectiveStatus === 'return_delivering') {
                if (Array.isArray(order.items)) {
                    order.items.forEach(i => {
                        i.status = 'return_delivering';
                        i.isPickedUp = true;
                    });
                    order.markModified('items');
                }
                order.status = 'return_delivering';
                await order.save();
            } else if (effectiveStatus === 'delivered') {
                order.deliveredAt = order.deliveredAt || new Date();
                if (deliverAll) {
                    if (Array.isArray(order.items)) {
                        order.items.forEach(i => {
                            i.status = 'delivered';
                            i.isDelivered = true;
                        });
                        order.markModified('items');
                    }
                    order.status = 'delivered';
                } else if (targetItem) {
                    targetItem.status = 'delivered';
                    targetItem.isDelivered = true;
                    if (Array.isArray(order.items) && order.items.length > 1) {
                        const allItemsDelivered = order.items.every(i => i.status === 'delivered' || i.isDelivered === true);
                        order.status = allItemsDelivered ? 'delivered' : 'delivering';
                    } else {
                        order.status = 'delivered';
                    }
                    order.markModified('items');
                } else {
                    if (Array.isArray(order.items)) {
                        order.items.forEach(i => {
                            i.status = 'delivered';
                            i.isDelivered = true;
                        });
                        order.markModified('items');
                    }
                    order.status = 'delivered';
                }
                await order.save();
            } else if (effectiveStatus === 'shipped') {
                if (targetItem) {
                    targetItem.status = 'shipped';
                    targetItem.isPickedUp = true;
                    if (Array.isArray(order.items) && order.items.length > 1) {
                        const allItemsShipped = order.items.every(i => i.status === 'shipped' || i.isPickedUp === true || i.isDelivered === true || i.status === 'delivered');
                        order.status = allItemsShipped ? 'shipped' : order.status;
                    } else {
                        order.status = 'shipped';
                    }
                    order.markModified('items');
                } else if (Array.isArray(order.items)) {
                    order.items.forEach(i => {
                        i.status = 'shipped';
                        i.isPickedUp = true;
                    });
                    order.markModified('items');
                    order.status = 'shipped';
                } else {
                    order.status = 'shipped';
                }
                await order.save();
            } else {
                if (order.status === effectiveStatus) {
                    // Already in this state, consider it a success for idempotency
                    continue;
                }

                const allowed = VALID_TRANSITIONS[order.status];
                if (!allowed || !allowed.includes(effectiveStatus)) {
                    return res.status(409).json({
                        message: `Cannot transition from '${order.status}' to '${effectiveStatus}'.`,
                        currentStatus: order.status,
                        allowedNext: allowed || [],
                    });
                }

                order.status = effectiveStatus;
                if (Array.isArray(order.items)) {
                    order.items.forEach(i => {
                        i.status = effectiveStatus;
                        if (effectiveStatus === 'delivered' || effectiveStatus === 'returned') i.isDelivered = true;
                        if (effectiveStatus === 'shipped' || effectiveStatus === 'return_delivering') i.isPickedUp = true;
                    });
                    order.markModified('items');
                }
                if (effectiveStatus === 'delivered') order.deliveredAt = order.deliveredAt || new Date();
                if (effectiveStatus === 'returned') {
                    if (!order.returnDetails) order.returnDetails = {};
                    order.returnDetails.returnDeliveredAt = new Date();
                }
                await order.save();
            }

            if (effectiveStatus === 'returned') {
                let isGroupAllReturned = false;
                if (order.parentGroupId) {
                    const groupSubs = await StoreOrder.find({ parentGroupId: order.parentGroupId });
                    isGroupAllReturned = groupSubs.every(s => s.status === 'returned' || s.status === 'delivered' || s.status === 'completed');
                } else {
                    isGroupAllReturned = true;
                }

                if (isGroupAllReturned) {
                    try {
                        const { creditWallet } = require('../middlewares/Wallet');
                        const returnFee = order.returnDetails?.deliveryFeeFils || order.deliveryPrice || 0;
                        const repEarnings = Math.round((returnFee * (order.businessRepCommissionPct || 100)) / 100);
                        if (repEarnings > 0 && repId) {
                            await creditWallet({
                                userId: repId,
                                amountFils: repEarnings,
                                type: 'order_earnings',
                                description: `أرباح توصيل مرتجع الطلب #${order.storeOrderId || order._id}`,
                                refId: String(order.storeOrderId || order._id),
                                performedBy: 'system',
                            }).catch(() => {});
                        }
                    } catch (_) {}
                    try {
                        const { clearRepCurrentOrder } = require('../redis/hrRedis');
                        await clearRepCurrentOrder(repId);
                    } catch (_) {}
                }
            } else if (effectiveStatus === 'delivered') {
                // ─── التأكد الصارم من أن جميع sub-orders في المجموعة تم تسليمها ───
                // default = false لمنع إرسال الإيميل قبل اكتمال جميع التسليمات
                let isGroupAllDelivered = false;

                if (order.parentGroupId) {
                    const groupSubs = await StoreOrder.find({ parentGroupId: order.parentGroupId });
                    isGroupAllDelivered = groupSubs.length > 0
                        && groupSubs.every(s => (s.status === 'delivered' || s.status === 'completed') && (!Array.isArray(s.items) || s.items.length === 0 || s.items.every(i => i.status === 'delivered' || i.isDelivered === true)));
                } else if (order.storeOrderId) {
                    // fallback: لو مفيش parentGroupId نجيب كل sub-orders بنفس storeOrderId
                    const groupSubs = await StoreOrder.find({ storeOrderId: order.storeOrderId });
                    isGroupAllDelivered = groupSubs.length > 0
                        && groupSubs.every(s => (s.status === 'delivered' || s.status === 'completed') && (!Array.isArray(s.items) || s.items.length === 0 || s.items.every(i => i.status === 'delivered' || i.isDelivered === true)));
                } else {
                    // أوردر منفرد بدون grouping → اعتبره مكتملاً
                    isGroupAllDelivered = !Array.isArray(order.items) || order.items.length === 0 || order.items.every(i => i.status === 'delivered' || i.isDelivered === true);
                }

                if (isGroupAllDelivered) {
                    const { processOrderCompletionWallet } = require('../middlewares/Wallet');
                    await processOrderCompletionWallet(order).catch((e) => console.error('[storeOrderController] Wallet error:', e.message));

                    const { sendBusinessOrderCompletionEmail, dispatchBackgroundEmail } = require('../services/emailService');
                    // نمرر parentGroupId ليتم جلب جميع الـ sub-orders من DB مع صورها الخاصة
                    const emailRef = order.parentGroupId || order.storeOrderId || order._id;
                    dispatchBackgroundEmail(async () => {
                        await sendBusinessOrderCompletionEmail(emailRef);
                    });
                }
            }

            try {
                const { setRepCurrentOrder, clearRepCurrentOrder, invalidateLiveDashboard } = require('../redis/hrRedis');
                // لا نحذف الأوردر الحالي للمندوب إلا إذا اكتملت جميع sub-orders في المجموعة بالكامل
                if (effectiveStatus === 'delivered') {
                    // handled above if group is delivered
                } else if (effectiveStatus === 'returned') {
                    // handled above if group is returned
                } else if (order.status === 'cancelled') {
                    const groupSubs = order.parentGroupId ? await StoreOrder.find({ parentGroupId: order.parentGroupId }) : [order];
                    if (groupSubs.every(s => s.status === 'cancelled')) {
                        await clearRepCurrentOrder(repId);
                    }
                } else {
                    await setRepCurrentOrder(repId, {
                        orderId: String(order.storeOrderId || order.parentGroupId || order._id),
                        status: order.status,
                        totalAmount: order.totalPrice,
                    });
                }
                await invalidateLiveDashboard();
            } catch (_) { }

            // ─── FCM Notifications PER SUB-ORDER ──────────────────────────────
            const agentStr = order.agentName ? ` من قِبل ${order.agentName}` : '';
            if (effectiveStatus === 'return_delivering') {
                notifyClient(
                    order.userId,
                    '🚚 تحديث حالة المرتجع',
                    'المندوب استلم الشحنة المرتجعة وهو في الطريق لتسليمها للوكيل/المتجر',
                    { type: 'store_order_return_delivering', storeOrderId: String(order.storeOrderId), orderId: String(order._id) }
                ).catch(() => { });
            } else if (effectiveStatus === 'returned') {
                notifyClient(
                    order.userId,
                    '✅ تم إرجاع طلبك بنجاح',
                    'تم تسليم المنتجات المرتجعة للوكيل/المتجر واكتمال عملية الاسترجاع.',
                    { type: 'store_order_returned', storeOrderId: String(order.storeOrderId), orderId: String(order._id) }
                ).catch(() => { });
            } else if (status === 'shipped') {
                notifyClient(
                    order.userId,
                    '🚚 تحديث حالة الطلب',
                    'تم استلام الشحنه من قبل المندوب وسيتم التواصل بك',
                    { type: 'store_order_shipped', storeOrderId: String(order.storeOrderId), orderId: String(order._id) }
                ).catch(() => { });
            } else if (status === 'delivered' && order.status === 'delivered') {
                notifyClient(
                    order.userId,
                    '✅ تحديث حالة الطلب',
                    'تم تسليم الاوردر بنجاح',
                    { type: 'store_order_delivered', storeOrderId: String(order.storeOrderId), orderId: String(order._id) }
                ).catch(() => { });
            } else if (status === 'cancelled') {
                notifyClient(
                    order.userId,
                    '❌ تم إلغاء جزء من طلبك',
                    `تم إلغاء طلبك${agentStr} من قِبَل المندوب`,
                    { type: 'store_order_cancelled', storeOrderId: String(order.storeOrderId), orderId: String(order._id) }
                ).catch(() => { });
            } else if (status === 'processing') {
                notifyClient(
                    order.userId,
                    '⏳ جاري تجهيز جزء من طلبك',
                    `المندوب يتجه لاستلام طلبك${agentStr}`,
                    { type: 'store_order_processing', storeOrderId: String(order.storeOrderId), orderId: String(order._id) }
                ).catch(() => { });
            }
        }

        // Fetch the full updated group to return
        const parentGroupId = ordersToUpdate[0].parentGroupId;
        let fullGroupOrders = [];
        if (parentGroupId) {
            fullGroupOrders = await StoreOrder.find({ parentGroupId }).sort({ storeOrderId: 1, subOrderIndex: 1 });
        } else if (ordersToUpdate[0].storeOrderId) {
            fullGroupOrders = await StoreOrder.find({ storeOrderId: ordersToUpdate[0].storeOrderId }).sort({ storeOrderId: 1, subOrderIndex: 1 });
        } else {
            fullGroupOrders = ordersToUpdate;
        }

        const enrichedList = await Promise.all(fullGroupOrders.map(o => enrichOrder(o)));
        const grouped = groupStoreOrders(enrichedList);
        const orderIdentifier = parentGroupId || ordersToUpdate[0]?.storeOrderId || id;
        const trackData = await BusinessOrderTracker.getOrderTrack(orderIdentifier).catch(() => null);

        const io = req.app?.get ? req.app.get('io') : null;
        if (io && trackData) {
            const rooms = [
                `order:${id}`,
                parentGroupId ? `order:${parentGroupId}` : null,
                ordersToUpdate[0]?.storeOrderId ? `order:${ordersToUpdate[0].storeOrderId}` : null,
                ordersToUpdate[0]?.representativeId ? `user:${ordersToUpdate[0].representativeId}` : null,
            ].filter(Boolean);

            rooms.forEach(r => {
                io.to(r).emit('order:track_updated', { orderId: id, track: trackData });
                io.to(r).emit('order:status_changed', { orderId: id, status, track: trackData });
            });
        }

        res.json({
            succeeded: true,
            message: `Order status updated to '${status}'`,
            track: trackData,
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
            const isValidId = isUuid || mongoose.Types.ObjectId.isValid(id) || !isNaN(Number(id));
            if (!isValidId) {
                return res.status(400).json({ message: 'Invalid order ID format' });
            }

            const ordersToUpdate = await findStoreOrdersByIdentifier(id, true);
            if (!ordersToUpdate.length) return res.status(404).json({ message: 'Order not found' });

            const photoUrl = req.file.path;
            const targetProdId = req.body?.productId || req.query?.productId;
            const rawTaskId = req.body?.taskId || req.query?.taskId;
            const rawItemIndex = req.body?.itemIndex ?? req.query?.itemIndex ?? req.body?.index ?? req.query?.index;

            // Target the specific order if multiple orders in group
            let targetOrders = ordersToUpdate;
            if (ordersToUpdate.length > 1) {
                let matchedOrder = null;
                if (targetProdId) {
                    matchedOrder = ordersToUpdate.find(o => Array.isArray(o.items) && o.items.some(i => String(i.product || i._id) === String(targetProdId)));
                }
                if (!matchedOrder && rawTaskId !== undefined && rawTaskId !== null && rawTaskId !== '') {
                    matchedOrder = ordersToUpdate.find(o => String(o.subOrderIndex) === String(rawTaskId) || String(o.storeOrderId) === String(rawTaskId) || String(o.orderId) === String(rawTaskId));
                }
                if (!matchedOrder) {
                    matchedOrder = ordersToUpdate.find(o => stage === 'pickup' ? (!o.pickupPhoto && !o.itemPhotoBefore) : (!o.deliveryPhoto && !o.itemPhotoAfter));
                }
                if (matchedOrder) {
                    targetOrders = [matchedOrder];
                }
            }

            for (const order of targetOrders) {
                if (Array.isArray(order.items) && order.items.length > 0) {
                    let targetItem = null;
                    if (targetProdId) {
                        targetItem = order.items.find(i => String(i.product || i._id) === String(targetProdId));
                    }
                    if (!targetItem && rawItemIndex !== undefined && rawItemIndex !== null && rawItemIndex !== '') {
                        const idx = parseInt(rawItemIndex, 10);
                        if (!isNaN(idx) && order.items[idx]) {
                            targetItem = order.items[idx];
                        }
                    }
                    if (!targetItem && rawTaskId !== undefined && rawTaskId !== null && rawTaskId !== '') {
                        const tId = parseInt(rawTaskId, 10);
                        if (!isNaN(tId) && tId >= 1 && order.items[tId - 1]) {
                            targetItem = order.items[tId - 1];
                        }
                    }
                    if (!targetItem) {
                        if (stage === 'pickup') {
                            targetItem = order.items.find(i => !i.pickupPhoto && !i.itemPhotoBefore && !i.pickupPhotoUrl);
                        } else {
                            targetItem = order.items.find(i => !i.deliveryPhoto && !i.itemPhotoAfter && !i.deliveryPhotoUrl);
                        }
                    }
                    if (!targetItem) {
                        targetItem = order.items[0];
                    }
                    if (targetItem) {
                        if (stage === 'pickup') {
                            targetItem.pickupPhoto = photoUrl;
                            targetItem.pickupPhotoUrl = photoUrl;
                            targetItem.itemPhotoBefore = photoUrl;
                        } else {
                            targetItem.deliveryPhoto = photoUrl;
                            targetItem.deliveryPhotoUrl = photoUrl;
                            targetItem.itemPhotoAfter = photoUrl;
                        }
                    }
                }

                if (stage === 'pickup') {
                    if (!order.pickupPhoto) {
                        order.pickupPhoto = photoUrl;
                        order.pickupPhotoUrl = photoUrl;
                        order.itemPhotoBefore = photoUrl;
                    }
                } else {
                    order.deliveryPhoto = photoUrl;
                    order.deliveryPhotoUrl = photoUrl;
                    order.itemPhotoAfter = photoUrl;
                }
                order.markModified('items');
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

/**
 * @desc   Get complete sequential tracking for a store/business order (or group)
 * @route  GET /api/store/orders/:id/track
 */
const getStoreOrderTrack = async (req, res) => {
    try {
        const { id } = req.params;
        const track = await BusinessOrderTracker.getOrderTrack(id);
        if (!track) {
            return res.status(404).json({ success: false, message: 'Order track not found' });
        }
        res.json({ success: true, track });
    } catch (err) {
        console.error('[getStoreOrderTrack]', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
};

/**
 * @desc   Check if a store order is eligible for return within 48 hours
 * @route  GET /api/store/orders/:id/return-eligibility
 * @access NormalUser (Order Owner)
 */
const checkReturnEligibility = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
        const isValidId = isUuid || mongoose.Types.ObjectId.isValid(id) || !isNaN(Number(id));
        if (!isValidId) {
            return res.status(400).json({ message: 'Invalid order ID format' });
        }

        const orders = await findStoreOrdersByIdentifier(id, isUuid);
        if (!orders.length) return res.status(404).json({ message: 'Order not found' });

        const firstOrder = orders[0];
        if (String(firstOrder.userId) !== String(userId) && !req.user.isAdmin) {
            return res.status(403).json({ message: 'Access denied. You do not own this order.' });
        }

        const isDelivered = orders.every(o => o.status === 'delivered' || o.status === 'completed');
        if (!isDelivered) {
            return res.status(400).json({
                eligible: false,
                code: 'ORDER_NOT_DELIVERED',
                message: 'لا يمكن تقديم طلب استرجاع إلا بعد استلام الطلب بالكامل.',
                currentStatus: firstOrder.status,
            });
        }

        if (orders.some(o => o.isReturnOrder || (typeof o.status === 'string' && o.status.startsWith('return_')) || o.status === 'returned')) {
            return res.status(400).json({
                eligible: false,
                code: 'ALREADY_RETURNED',
                message: 'تم تقديم طلب استرجاع لهذا الطلب مسبقاً.',
                currentStatus: firstOrder.status,
            });
        }

        const deliveryTimestamp = firstOrder.deliveredAt || firstOrder.updatedAt || new Date();
        const maxReturnMs = 48 * 60 * 60 * 1000;
        let elapsedMs = 0;
        if (firstOrder.deliveredAt) {
            elapsedMs = Date.now() - new Date(firstOrder.deliveredAt).getTime();
        } else {
            // deliveredAt was missing on delivered order: stamp now so future checks have exact timestamp
            firstOrder.deliveredAt = deliveryTimestamp;
            await firstOrder.save().catch(() => {});
        }
        const remainingMs = maxReturnMs - elapsedMs;

        if (remainingMs <= 0 && firstOrder.deliveredAt) {
            return res.status(400).json({
                canReturn: false,
                eligible: false,
                returnWindowExpired: true,
                code: 'RETURN_WINDOW_EXPIRED',
                message: 'تعديت الحد الأقصى لمده الاسترجاع (يومان من تاريخ الاستلام).',
                deliveredAt: deliveryTimestamp,
                hoursSinceDelivery: Number((elapsedMs / (60 * 60 * 1000)).toFixed(1)),
                maxHours: 48,
            });
        }

        const remainingHours = Math.max(0, Number((remainingMs / (60 * 60 * 1000)).toFixed(1)));
        const totalDeliveryFee = orders.reduce((sum, o) => sum + (o.deliveryPrice || o.totalDeliveryPrice || 0), 0);
        const allItems = orders.flatMap(o => o.items || []);

        return res.json({
            canReturn: true,
            eligible: true,
            returnWindowExpired: false,
            returnWindowRemainingHours: Math.round(remainingHours),
            orderId: firstOrder.storeOrderId || firstOrder._id,
            parentGroupId: firstOrder.parentGroupId,
            deliveredAt: deliveryTimestamp,
            deadline: new Date(new Date(deliveryTimestamp).getTime() + maxReturnMs),
            hoursRemaining: remainingHours,
            deliveryPriceFils: totalDeliveryFee,
            deliveryPriceKWD: (totalDeliveryFee / 1000).toFixed(3),
            feeWarningNotice: `تنبيه: سيتم تطبيق سعر التوصيل (${(totalDeliveryFee / 1000).toFixed(3)} د.ك) على رحلة الاسترجاع وتلتزم بسدادها للمندوب عند الاستلام.`,
            items: allItems.map((item, idx) => ({
                productId: item.product,
                name: item.name,
                price: item.price,
                quantity: item.quantity,
                subtotal: item.subtotal,
                productImage: item.productImage,
                itemIndex: item.itemIndex || (idx + 1),
            })),
        });
    } catch (err) {
        console.error('[checkReturnEligibility]', err.message);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

/**
 * @desc   Client requests a return for a delivered store order within 48 hours
 * @route  POST /api/store/orders/:id/request-return
 * @body   { reason: string, agreeToDeliveryFee: boolean, items?: Array }
 * @access NormalUser (Order Owner)
 */
const requestStoreOrderReturn = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const { reason, agreeToDeliveryFee, items } = req.body;

        if (!reason || typeof reason !== 'string' || !reason.trim()) {
            return res.status(400).json({
                code: 'REASON_REQUIRED',
                message: 'سبب الاسترجاع مطلوب.',
            });
        }

        if (agreeToDeliveryFee !== true && agreeToDeliveryFee !== 'true') {
            return res.status(400).json({
                code: 'FEE_AGREEMENT_REQUIRED',
                message: 'يجب الموافقة على دفع سعر التوصيل الخاص بطلب الاسترجاع.',
            });
        }

        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
        const isValidId = isUuid || mongoose.Types.ObjectId.isValid(id) || !isNaN(Number(id));
        if (!isValidId) {
            return res.status(400).json({ message: 'Invalid order ID format' });
        }

        const orders = await findStoreOrdersByIdentifier(id, isUuid);
        if (!orders.length) return res.status(404).json({ message: 'Order not found' });

        const firstOrder = orders[0];
        if (String(firstOrder.userId) !== String(userId) && !req.user.isAdmin) {
            return res.status(403).json({ message: 'Access denied. You do not own this order.' });
        }

        const isDelivered = orders.every(o => o.status === 'delivered' || o.status === 'completed');
        if (!isDelivered) {
            return res.status(400).json({
                code: 'ORDER_NOT_DELIVERED',
                message: 'لا يمكن طلب استرجاع إلا للطلبات المستلمة بالكامل.',
            });
        }

        if (orders.some(o => o.isReturnOrder || (typeof o.status === 'string' && o.status.startsWith('return_')) || o.status === 'returned')) {
            return res.status(400).json({
                code: 'ALREADY_RETURNED',
                message: 'تم تقديم طلب استرجاع لهذا الطلب مسبقاً.',
            });
        }

        // Check 48 hours maximum window
        const deliveryTimestamp = firstOrder.deliveredAt || firstOrder.updatedAt || new Date();
        const maxReturnMs = 48 * 60 * 60 * 1000;
        let elapsedMs = 0;
        if (firstOrder.deliveredAt) {
            elapsedMs = Date.now() - new Date(firstOrder.deliveredAt).getTime();
            if (elapsedMs > maxReturnMs) {
                return res.status(400).json({
                    code: 'RETURN_WINDOW_EXPIRED',
                    message: 'تعديت الحد الأقصى لمده الاسترجاع (يومان من تاريخ الاستلام).',
                    deliveredAt: deliveryTimestamp,
                    hoursSinceDelivery: Number((elapsedMs / (60 * 60 * 1000)).toFixed(1)),
                    maxHours: 48,
                });
            }
        }

        const now = new Date();
        const totalDeliveryFee = orders.reduce((sum, o) => sum + (o.deliveryPrice || o.totalDeliveryPrice || 0), 0);

        // Update all sub-orders in the group to return_pending
        for (const order of orders) {
            const orderItems = Array.isArray(order.items) ? order.items : [];
            let returnedItemsList = orderItems;
            if (Array.isArray(items) && items.length > 0) {
                const targetIds = items.map(it => String(it.productId || it.product || it._id));
                returnedItemsList = orderItems.filter(it => targetIds.includes(String(it.product || it._id)));
                if (!returnedItemsList.length) returnedItemsList = orderItems;
            }

            order.status = 'return_pending';
            order.isReturnOrder = true;
            order.returnReason = reason.trim();
            order.representativeId = null; // Unassign representative so any available representative can accept
            order.acceptedAt = null;
            order.returnDetails = {
                requestedAt: now,
                reason: reason.trim(),
                deliveryFeeFils: order.deliveryPrice || order.totalDeliveryPrice || totalDeliveryFee,
                customerAgreedToFee: true,
                originalDeliveredAt: deliveryTimestamp,
                returnedItems: returnedItemsList.map(it => ({
                    productId: it.product,
                    name: it.name,
                    quantity: it.quantity,
                    price: it.price,
                    subtotal: it.subtotal,
                    productImage: it.productImage,
                    itemIndex: it.itemIndex,
                })),
                pickupPhoto: null,
                deliveryPhoto: null,
            };

            await order.save();
        }

        // Notify Representatives via Broadcast & FCM
        try {
            const io = req.app.get('io');
            if (io) {
                io.emit('store:order:return_requested', {
                    orderId: String(firstOrder.storeOrderId || firstOrder._id),
                    parentGroupId: firstOrder.parentGroupId,
                    status: 'return_pending',
                    totalDeliveryFee,
                });
            }
        } catch (_) {}

        const grouped = groupStoreOrders(orders);
        const enriched = await enrichOrder(req, grouped[0]);

        return res.json({
            succeeded: true,
            message: 'تم تقديم طلب الاسترجاع بنجاح وتحويل الطلب إلى قيد الانتظار (مرتجع).',
            status: 'return_pending',
            returnDeliveryFee: totalDeliveryFee,
            order: enriched,
        });
    } catch (err) {
        console.error('[requestStoreOrderReturn]', err.message);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

/**
 * @desc   Client cancels a pending return request (reverts back to delivered)
 * @route  PATCH /api/store/orders/:id/cancel-return
 * @access NormalUser (Order Owner)
 */
const cancelStoreOrderReturn = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
        const isValidId = isUuid || mongoose.Types.ObjectId.isValid(id) || !isNaN(Number(id));
        if (!isValidId) {
            return res.status(400).json({ message: 'Invalid order ID format' });
        }

        const orders = await findStoreOrdersByIdentifier(id, isUuid);
        if (!orders.length) return res.status(404).json({ message: 'Order not found' });

        const firstOrder = orders[0];
        if (String(firstOrder.userId) !== String(userId) && !req.user.isAdmin) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        if (orders.some(o => o.status !== 'return_pending')) {
            return res.status(400).json({
                message: 'لا يمكن إلغاء المرتجع بعد قبوله من المندوب أو البدء في تنفيذه.',
                currentStatus: firstOrder.status,
            });
        }

        for (const order of orders) {
            order.status = 'delivered';
            order.isReturnOrder = false;
            await order.save();
        }

        return res.json({
            succeeded: true,
            message: 'تم إلغاء طلب الاسترجاع وإعادة الطلب لحالة مستلم.',
            status: 'delivered',
        });
    } catch (err) {
        console.error('[cancelStoreOrderReturn]', err.message);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = {
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
    // ─── Helpers ──────────────────────────────────────────────
    enrichOrder,
    enrichOrderImages,
    groupStoreOrders,
    findStoreOrdersByIdentifier,
};

