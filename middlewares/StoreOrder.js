const mongoose = require('mongoose');
const joi = require('joi');
const { ORDER_STATUSES } = require('../constants/orderTypes');

// ─── Store Order Status ──────────────────────────────────────────────────────
const STORE_ORDER_STATUSES = Array.from(new Set([
    ...ORDER_STATUSES,
    'pending',
    'confirmed',
    'processing',
    'shipped',
    'delivered',
    'completed',
    'cancelled',
    'deleted',
    'review',
    'delayed',
    'accepted',
    'delivering',
    'waiting',
    'in_progress',
    'inprogress',
    'return_pending',
    'return_accepted',
    'return_delivering',
    'returned',
    'return_cancelled',
]));

// ─── Store Order Item Sub-Schema ─────────────────────────────────────────────
const StoreOrderItemSchema = new mongoose.Schema(
    {
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: true,
        },
        name: { type: String, required: true, trim: true },   // snapshot at order time
        price: { type: Number, required: true, min: 0 },       // snapshot at order time
        quantity: { type: Number, required: true, min: 1 },
        subtotal: { type: Number, required: true, min: 0 },
        productImage: { type: String, default: null },         // first image snapshot at order time
        agentIds: { type: [String], default: [] },             // agents who own this product at time of order
        // ─── Association link (if product belongs to a جمعية) ────────────────
        // Stored so the representative always knows this item came from an association.
        associationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Association',
            default: null,
        },
        associationName: { type: String, default: null },      // snapshot at order time
        // ─── Restaurant link (if product belongs to a مطعم) ──────────────────
        restaurantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Restaurant',
            default: null,
        },
        restaurantName: { type: String, default: null },       // snapshot at order time
        // ─── Selected Add-ons snapshot (إضافات الوجبة) ────────────────────────
        selectedAddons: [
            {
                name: { type: String, required: true },
                price: { type: Number, default: 0 },
            }
        ],
        addonsTotal: { type: Number, default: 0 },
        // ─── Per-item delivery location ──────────────────────────────────────
        // Delivery destination chosen by the client for this specific product.
        // Falls back to the parent order's deliveryLocation if not set.
        deliveryLocation: {
            lat:     { type: Number, default: null },
            lng:     { type: Number, default: null },
            address: { type: String, trim: true, default: '' },
        },
        // ─── Pickup location ─────────────────────────────────────────────────
        // For association items: the association's pickupLocation (set by admin).
        // For restaurant items: the restaurant's pickupLocation (set by admin).
        // For agent items: the agent's product pickupLocation.
        pickupLocation: {
            lat:     { type: Number, default: null },
            lng:     { type: Number, default: null },
            address: { type: String, trim: true, default: '' },
        },
        requiredVehicleTypeId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'VehicleType',
            default: null,
        },
        requiredVehicleTypeName: { type: String, trim: true, default: null },
        // ─── Representative Product Pickup & Delivery Proof Photos ─────────────────────
        pickupPhotoUrl: { type: String, default: null },
        deliveryPhotoUrl: { type: String, default: null },
        pickupPhoto: { type: String, default: null },
        deliveryPhoto: { type: String, default: null },
        itemPhotoBefore: { type: String, default: null },
        itemPhotoAfter: { type: String, default: null },
        itemIndex: { type: Number, default: 0 },
        status: { type: String, enum: STORE_ORDER_STATUSES, default: 'pending' },
        isDelivered: { type: Boolean, default: false },
        isPickedUp: { type: Boolean, default: false },
    },
    { _id: false }
);

// ─── Auto-increment counter for storeOrderId ─────────────────────────────────
const StoreCounterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
});
const StoreCounter = mongoose.model('StoreCounter', StoreCounterSchema);

async function getNextStoreOrderId() {
    const { getNextGlobalOrderId } = require('./Order');
    return await getNextGlobalOrderId();
}

// ─── Store Order Schema ──────────────────────────────────────────────────────
const StoreOrderSchema = new mongoose.Schema(
    {
        orderId: { type: Number, index: true },
        storeOrderId: { type: Number, index: true },
        subOrderIndex: { type: Number, default: 0 },
        orderCategory: { type: String, trim: true, default: 'business' },
        isBusinessOrder: { type: Boolean, default: true },


        // ─── Order grouping (split orders) ───────────────────────────────
        // When a client has products from multiple agents, one checkout creates
        // multiple sub-orders. They all share the same parentGroupId.
        // The representative sees ALL sub-orders with the same parentGroupId.
        parentGroupId: {
            type: String,   // UUID generated at checkout time
            default: null,
            index: true,
        },

        // The single agent this sub-order belongs to (null for old orders or association orders).
        agentId: { type: String, default: null, trim: true },
        agentName: { type: String, default: null, trim: true },

        // ─── Association link (if this sub-order is for a جمعية) ─────────────
        // Set when checkout groups items from a product belonging to an association.
        associationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Association',
            default: null,
        },
        associationName: { type: String, default: null, trim: true },

        // ─── Restaurant link (if this sub-order is for a مطعم) ───────────────
        restaurantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Restaurant',
            default: null,
        },
        restaurantName: { type: String, default: null, trim: true },

        // ─── Vehicle Requirements ──────────────────────────────────────────
        requiredVehicleTypeId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'VehicleType',
            default: null,
        },
        requiredVehicleTypeName: { type: String, trim: true, default: null },

        // Buyer info (stored as string id to match existing pattern)
        userId: { type: String, required: true, trim: true },
        clientId: { type: String, trim: true, default: null },
        userInfo: {
            firstName: { type: String, default: '' },
            lastName: { type: String, default: '' },
            email: { type: String, default: '' },
            phone: { type: String, default: '' },
        },

        items: { type: [StoreOrderItemSchema], default: [] },

        totalPrice: { type: Number, required: true, min: 0 },
        deliveryPrice: { type: Number, default: 0, min: 0 },
        totalDeliveryPrice: { type: Number, default: 0, min: 0 },
        deliveryDistanceMeters: { type: Number, default: 0, min: 0 },

        status: {
            type: String,
            enum: STORE_ORDER_STATUSES,
            default: 'pending',
        },
        
        reviewReason: { type: String, trim: true, default: null },

        // ─── Representative Photos ───────────────────────────────────
        pickupPhoto: { type: String, default: null },
        deliveryPhoto: { type: String, default: null },
        hasCompletionEmailSent: { type: Boolean, default: false },
        
        // ─── PoD V2 ──────────────────────────────────────────────────
        activeDeliverySessionId: { type: String, default: null },

        notes: { type: String, trim: true, default: '' },

        // ─── Payment Method ──────────────────────────────────────────
        paymentMethod: {
            type: String,
            enum: ['cash', 'visa', 'wallet'],
            default: 'cash',
            required: true,
        },

        // ─── Default Delivery Location ───────────────────────────────
        // Checkout-level fallback location. Each item may override this.
        deliveryLocation: {
            lat: { type: Number, default: 0 },
            lng: { type: Number, default: 0 },
            address: { type: String, trim: true, default: '' },
        },

        involvedAgents: { type: [String], default: [] }, // Union of all agentIds from items for fast queries

        // ─── Representative (driver) who accepted this order ─────────────
        representativeId: { type: String, default: null, trim: true },
        acceptedAt: { type: Date, default: null },

        // ─── تايمر الوصول وتأخير العميل ─────────────────────────────────
        arrivalConfirmedAt: { type: Date, default: null },
        arrivalTimerExpiredAt: { type: Date, default: null },
        isClientDelayed: { type: Boolean, default: false },
        delayedAt: { type: Date, default: null },

        // ─── Wallet & Commission Tracking ────────────────────────────────
        isWalletProcessed: { type: Boolean, default: false },
        companyCommissionFils: { type: Number, default: 0 },
        companyCommissionDeducted: { type: Boolean, default: false },
        repEarningsFils: { type: Number, default: 0 },

        // ─── Return System (نظام الاسترجاع) ──────────────────────────────
        deliveredAt: { type: Date, default: null, index: true },
        isReturnOrder: { type: Boolean, default: false, index: true },
        returnDetails: {
            requestedAt: { type: Date, default: null },
            reason: { type: String, trim: true, default: '' },
            deliveryFeeFils: { type: Number, default: 0 },
            customerAgreedToFee: { type: Boolean, default: false },
            originalDeliveredAt: { type: Date, default: null },
            returnedItems: {
                type: [{
                    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
                    name: { type: String, default: '' },
                    quantity: { type: Number, default: 1 },
                    price: { type: Number, default: 0 },
                    subtotal: { type: Number, default: 0 },
                    productImage: { type: String, default: null },
                    itemIndex: { type: Number, default: 0 },
                }],
                default: [],
            },
            pickupPhoto: { type: String, default: null },
            deliveryPhoto: { type: String, default: null },
        },
    },
    { timestamps: true }
);

StoreOrderSchema.pre('validate', function () {
    if (!this.userId && this.clientId) {
        this.userId = String(this.clientId);
    }
    if (!this.paymentMethod) {
        this.paymentMethod = 'cash';
    }
});

/** Store prices in integer fils (precision down to 1 fil) and assign auto-increment storeOrderId & orderId before saving */
StoreOrderSchema.pre('save', async function () {
    if (this.deliveryPrice != null && !isNaN(this.deliveryPrice)) {
        this.deliveryPrice = Math.round(Number(this.deliveryPrice));
    }
    if (this.totalDeliveryPrice != null && !isNaN(this.totalDeliveryPrice)) {
        this.totalDeliveryPrice = Math.round(Number(this.totalDeliveryPrice));
    } else if (this.deliveryPrice != null) {
        this.totalDeliveryPrice = this.deliveryPrice;
    }
    if (this.totalPrice != null && !isNaN(this.totalPrice)) {
        this.totalPrice = Math.round(Number(this.totalPrice));
    }

    if (!this.clientId && this.userId) {
        this.clientId = String(this.userId);
    } else if (!this.userId && this.clientId) {
        this.userId = String(this.clientId);
    }
    if (!this.paymentMethod) {
        this.paymentMethod = 'cash';
    }

    if (this.isNew) {
        const { getNextGlobalOrderId } = require('./Order');
        // إذا تم تحديد storeOrderId أو orderId مسبقاً (من checkout للمجموعة)، نضمن فرادة orderId
        if (!this.orderId && !this.storeOrderId) {
            const nextId = await getNextGlobalOrderId();
            this.orderId = nextId;
            this.storeOrderId = nextId;
        } else if (!this.orderId) {
            this.orderId = await getNextGlobalOrderId();
        } else if (!this.storeOrderId) {
            this.storeOrderId = this.orderId;
        }
    }
});


const StoreOrder = mongoose.model('StoreOrder', StoreOrderSchema, 'orders');

// ─── Joi Validators ──────────────────────────────────────────────────────────

const locationSchema = joi.object({
    lat: joi.number().min(-90).max(90).required(),
    lng: joi.number().min(-180).max(180).required(),
    address: joi.string().trim().max(500).allow('', null).optional().default(''),
});

function validateCreateStoreOrder(obj) {
    const schema = joi.object({
        notes: joi.string().trim().max(1000).allow('').default(''),
        paymentMethod: joi.string().valid('cash', 'visa', 'wallet').required()
            .messages({ 'any.only': 'paymentMethod must be cash, visa, or wallet' }),
        deliveryLocation: locationSchema.optional().default({ lat: 0, lng: 0, address: '' }),
        itemLocations: joi.array().items(joi.object({
            productId: joi.string().length(24).required(),
            pickupLocation: locationSchema.optional(),
            deliveryLocation: locationSchema.optional(),
        })).optional().default([]),
        deliveryPrice: joi.number().min(0).optional().default(0),
        deliveryDistanceMeters: joi.number().min(0).optional().default(0),
        // Allow normal order fields so Flutter can reuse the same payload structure without crashing
        totalDistanceKm: joi.number().min(0).optional().allow(null),
        totalDeliveryPrice: joi.number().min(0).optional().allow(null),
        originalDeliveryPrice: joi.number().min(0).optional().allow(null),
        totalPrice: joi.number().min(0).optional().allow(null),
        discountAmount: joi.number().min(0).optional().allow(null),
    });
    return schema.validate(obj, { abortEarly: false, allowUnknown: true });
}

function validateUpdateStoreOrderStatus(obj) {
    const schema = joi.object({
        status: joi.string().valid(...STORE_ORDER_STATUSES).required()
            .messages({ 'any.only': `status must be one of: ${STORE_ORDER_STATUSES.join(', ')}` }),
    });
    return schema.validate(obj);
}

module.exports = {
    StoreOrder,
    STORE_ORDER_STATUSES,
    validateCreateStoreOrder,
    validateUpdateStoreOrderStatus,
    getNextStoreOrderId,
};
