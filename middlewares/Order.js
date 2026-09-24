const mongoose = require('mongoose');
const joi = require('joi');
const { ORDER_STATUSES, TASK_TYPES, TASK_STATUSES } = require('../constants/orderTypes');

/** Auto-increment counter for global_order_id */
const CounterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
});
const Counter = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);

let orderIdCounterSynced = false;

async function ensureOrderIdCounterSynced() {
    if (orderIdCounterSynced) return;
    try {
        const existing = await Counter.findById('global_order_id').lean();
        const ordersCol = mongoose.connection.collection('orders');
        const maxDocs = await ordersCol
            .find({ orderId: { $type: 'number' } })
            .sort({ orderId: -1 })
            .limit(1)
            .toArray();
        const maxExisting = maxDocs[0]?.orderId ?? 0;

        const currentSeq = existing?.seq ?? 0;
        if (maxExisting > currentSeq || !existing) {
            await Counter.findByIdAndUpdate(
                'global_order_id',
                { $set: { seq: Math.max(maxExisting, currentSeq) } },
                { upsert: true }
            );
        }
        orderIdCounterSynced = true;
    } catch (err) {
        // Fallback: don't crash if DB connection is still initializing
    }
}

async function getNextGlobalOrderId() {
    await ensureOrderIdCounterSynced();
    const counter = await Counter.findByIdAndUpdate(
        'global_order_id',
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );
    return counter.seq;
}

let taskIdCounterSynced = false;

/** Sync taskId counter once with max existing taskId in DB so new IDs continue after legacy data. */
async function ensureTaskIdCounterSynced() {
    if (taskIdCounterSynced) return;
    const existing = await Counter.findById('taskId').lean();
    if (existing && existing.seq > 0) {
        taskIdCounterSynced = true;
        return;
    }
    const agg = await Order.aggregate([
        { $unwind: { path: '$tasks', preserveNullAndEmptyArrays: false } },
        { $group: { _id: null, maxId: { $max: '$tasks.taskId' } } },
    ]);
    const maxExisting = agg[0]?.maxId ?? 0;
    await Counter.findByIdAndUpdate(
        'taskId',
        { $set: { seq: maxExisting } },
        { upsert: true }
    );
    taskIdCounterSynced = true;
}

/** Global auto-increment for taskId (continues across all orders, not per-order). */
async function getNextTaskId() {
    await ensureTaskIdCounterSynced();
    const counter = await Counter.findByIdAndUpdate(
        'taskId',
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );
    return counter.seq;
}


/** Order status & task types: see `constants/orderTypes.js` */

const PurchaseItemSchema = new mongoose.Schema(
    {
        name: { type: String, trim: true, default: '' },
        quantity: { type: Number, default: 0 },
        price: { type: Number, default: 0 },
    },
    { _id: false }
);

const LocationSchema = new mongoose.Schema(
    {
        streetName: { type: String, trim: true, default: '' },
        entranceNumber: { type: String, trim: true, default: '' },
        phoneNumber: { type: String, trim: true, default: '' },
    },
    { _id: false }
);

const TaskSchema = new mongoose.Schema(
    {
        taskId: { type: Number, required: true },
        type: { type: String, enum: [...TASK_TYPES], required: true },
        // حالة التاسك — pending | picked_up | completed
        taskStatus: { type: String, enum: [...TASK_STATUSES], default: 'pending' },
        arrivedAt: { type: Date, default: null },    // وقت وصول المندوب لنقطة الاستلام
        deliveredAt: { type: Date, default: null },  // وقت اكتمال التسليم
        fromLatitude: { type: Number, default: 0 },
        fromLongitude: { type: Number, default: 0 },
        toLatitude: { type: Number, default: 0 },
        toLongitude: { type: Number, default: 0 },
        googleMapAddressFrom: { type: String, trim: true, default: '' },
        googleMapAddressTo: { type: String, trim: true, default: '' },
        pickupLocation: { type: LocationSchema, default: () => ({}) },
        deliveryLocation: { type: LocationSchema, default: () => ({}) },
        paymentLocation: { type: String, trim: true, default: '' },
        isClientPaidForItems: { type: Boolean, default: false },
        isDriverReimbursed: { type: Boolean, default: false },
        deliveryDescription: { type: String, trim: true, default: '' },
        itemPhotoBefore: { type: String, trim: true, default: '' },
        itemPhotoAfter: { type: String, trim: true, default: '' },
        purchaseItems: { type: [PurchaseItemSchema], default: [] },
    },
    { _id: false }
);

const OrderSchema = new mongoose.Schema(
    {
        orderId: { type: Number, unique: true },
        clientId: {
            type: String,
            required: function () {
                return !this.isBusinessOrder && this.orderCategory !== 'business';
            },
            trim: true,
        },
        representativeId: { type: String, trim: true, default: null },

        // سعر التوصيل الأصلي قبل الخصم (بالفلس)
        originalDeliveryPrice: { type: Number, default: null },
        // سعر التوصيل بعد الخصم (بالفلس) — هو نفس القيمة المستخدمة في الدفع
        totalDeliveryPrice: { type: Number, default: 0 },
        // مقدار الخصم الذي خُصم (بالفلس) — 0 إذا لم يُستخدم خصم
        discountAmount: { type: Number, default: 0 },
        // نسبة الخصم 0-100 (إذا كان النوع percentage) — null إذا لم يُستخدم
        discountPercentage: { type: Number, default: null },
        // كود الخصم المستخدم — null إذا لم يُستخدم كود
        discountCode: { type: String, trim: true, default: null },
        // نوع الخصم: 'percentage' | 'fixed' | 'user_discount' — null إذا لم يُستخدم
        discountType: { type: String, trim: true, default: null },

        totalPrice: { type: Number, default: 0 },
        totalDistanceKm: { type: Number, default: 0 },
        vehicleTypeId: { type: String, trim: true, default: null },
        vehicleName: { type: String, trim: true, default: null },
        vehicleTypeName: { type: String, trim: true, default: null },
        orderType: { type: String, trim: true, default: null },
        orderCategory: { type: String, trim: true, default: 'delivery' },
        isBusinessOrder: { type: Boolean, default: false },
        storeOrderId: { type: Number, default: null, index: true },
        parentGroupId: { type: String, default: null, index: true },
        items: { type: [mongoose.Schema.Types.Mixed], default: [] },
        status: {
            type: String,
            enum: ORDER_STATUSES,
            default: 'waiting',
        },
        cancellationReason: { type: String, trim: true, default: null },
        reviewReason: { type: String, trim: true, default: null },
        tasks: { type: [TaskSchema], default: [] },

        // ─── حقول التايمر والتأخير ────────────────────────────────────────────────
        // وقت قبول المندوب للأوردر — يُستخدم لحساب رسوم الإلغاء
        acceptedAt: { type: Date, default: null },
        // وقت ضغط المندوب على "تأكيد الوصول" لنقطة الاستلام
        arrivalConfirmedAt: { type: Date, default: null },
        // وقت انتهاء التايمر = arrivalConfirmedAt + arrivalTimerMinutes
        arrivalTimerExpiredAt: { type: Date, default: null },
        // هل ضغط المندوب على "العميل تأخر"؟
        isClientDelayed: { type: Boolean, default: false },
        // وقت تسجيل التأخير
        delayedAt: { type: Date, default: null },
        
        allLocationsInOrder: { type: [mongoose.Schema.Types.Mixed], default: [] },
        
        // ─── PoD V2 ─────────────────────────────────────────────────────────────
        activeDeliverySessionId: { type: String, default: null },
        isWalletProcessed: { type: Boolean, default: false },
        companyCommissionFils: { type: Number, default: 0 },
        companyCommissionDeducted: { type: Boolean, default: false },
        repEarningsFils: { type: Number, default: 0 },
        
        // ─── Route Single Source of Truth ─────────────────────────────────────────
        pricingVersion: { type: Number, default: 1 },
        routeStatus: { type: String, enum: ['READY', 'FAILED', 'PROCESSING'], default: 'PROCESSING' },
        routeSource: { type: String, enum: ['GOOGLE', 'CACHE', 'REROUTE'], default: 'GOOGLE' },
        routeSnapshot: {
            schemaVersion: { type: Number, default: 1 },
            encodedPolyline: { type: String, default: null },
            legPolylines: { type: [String], default: [] },
            compression: { type: String, enum: ['none', 'gzip', 'brotli'], default: 'none' },
            routeChecksum: { type: String, default: null },
            distanceMeters: { type: Number, default: 0 },
            durationSeconds: { type: Number, default: 0 },
            routeCreatedAt: { type: Date, default: null },
            travelMode: { type: String, default: 'DRIVE' },
            routingPreference: { type: String, default: 'TRAFFIC_AWARE' },
            polylineQuality: { type: String, default: 'HIGH_QUALITY' },
            polylineEncoding: { type: String, default: 'ENCODED_POLYLINE' },
            provider: { type: String, default: 'google' },
            providerVersion: { type: String, default: 'v2' }
        },
    },
    { timestamps: true }
);

OrderSchema.index({ status: 1, isBusinessOrder: 1, createdAt: -1 });
OrderSchema.index({ status: 1, orderCategory: 1, createdAt: -1 });
OrderSchema.index({ createdAt: -1 });

OrderSchema.pre('validate', function () {
    if (!this.clientId && (this.userId || this._doc?.userId)) {
        this.clientId = String(this.userId || this._doc?.userId);
    }
});

/** Assign auto-increment orderId before saving */
OrderSchema.pre('save', async function () {
    if (this.isNew && !this.orderId) {
        this.orderId = await getNextGlobalOrderId();
    }
    if (!this.clientId && (this.userId || this._doc?.userId)) {
        this.clientId = String(this.userId || this._doc?.userId);
    }
});

const Order = mongoose.model('Order', OrderSchema, 'orders');

/** One-time migration: assign unified global orderId (1, 2, 3...) to all existing Order and StoreOrder documents in 'orders' */
async function migrateUnifiedOrderIds() {
    try {
        const existingCounter = await Counter.findById('global_order_id');
        if (existingCounter && existingCounter.seq > 0) {
            return; // Migration already completed, skip scanning database on boot
        }

        const legacyStoreCol = mongoose.connection.collection('storeorders');
        let legacyDocs = [];
        try {
            legacyDocs = await legacyStoreCol.find({}).toArray();
        } catch (_) {}

        if (legacyDocs.length > 0) {
            console.log(`🔄 [Migration] Found ${legacyDocs.length} documents in legacy storeorders collection. Migrating to 'orders'...`);
            const ordersCol = mongoose.connection.collection('orders');
            for (const doc of legacyDocs) {
                const existing = await ordersCol.findOne({ _id: doc._id });
                if (!existing) {
                    doc.orderCategory = doc.orderCategory || 'business';
                    doc.isBusinessOrder = true;
                    await ordersCol.insertOne(doc);
                }
            }
            try {
                await legacyStoreCol.drop();
                console.log('✅ [Migration] Legacy storeorders collection dropped.');
            } catch (dropErr) {
                console.warn('⚠️ [Migration] Could not drop legacy storeorders collection:', dropErr.message);
            }
        }
        
        console.log('🔄 [Migration] Starting unified global order ID assignment...');
        
        const ordersCol = mongoose.connection.collection('orders');
        const allDocs = await ordersCol.find({}).sort({ createdAt: 1 }).toArray();

        if (allDocs.length === 0) {
            return;
        }

        let currentSeq = 0;
        for (const doc of allDocs) {
            currentSeq++;
            const updateFields = { orderId: currentSeq };
            if (doc.items || doc.storeOrderId || doc.isBusinessOrder || doc.orderCategory === 'business') {
                updateFields.storeOrderId = currentSeq;
                updateFields.isBusinessOrder = true;
                updateFields.orderCategory = 'business';
            } else {
                updateFields.isBusinessOrder = false;
                updateFields.orderCategory = 'delivery';
            }
            await ordersCol.updateOne({ _id: doc._id }, { $set: updateFields });
        }

        await Counter.findByIdAndUpdate(
            'global_order_id',
            { $set: { seq: currentSeq } },
            { upsert: true }
        );

        console.log(`✅ [Migration] Successfully assigned unified global order IDs 1 to ${currentSeq} across all orders in 'orders' collection.`);
    } catch (e) {
        console.error('❌ [Migration] Unified Order ID migration error:', e.message);
    }
}

/** One-time migration: legacy numeric status → string (run after DB connect). */
async function migrateOrderStatusFromNumbersToStrings() {
    const map = [
        [0, 'waiting'],
        [1, 'accepted'],
        [2, 'completed'],
        [3, 'cancelled'],
    ];
    for (const [num, str] of map) {
        const res = await Order.updateMany({ status: num }, { $set: { status: str } });
        if (res.modifiedCount > 0) {
            console.log(`✅ Migrated ${res.modifiedCount} orders: status ${num} → "${str}"`);
        }
    }
}


// ─── Joi validation ──────────────────────────────────────────────────────────

const locationSchema = joi.object({
    streetName: joi.string().trim().allow('', null).default(''),
    entranceNumber: joi.string().trim().allow('', null).default(''),
    phoneNumber: joi.string().trim().allow('', null).default(''),
});

const purchaseItemSchema = joi.object({
    name: joi.string().trim().allow('', null).default(''),
    quantity: joi.number().allow(null).min(0).default(0),
    price: joi.number().allow(null).min(0).default(0),
});

const taskSchema = joi.object({
    taskId: joi.any().forbidden().messages({
        'any.unknown': 'taskId is generated automatically',
    }),
    type: joi
        .string()
        .valid(...TASK_TYPES)
        .required()
        .messages({
            'any.required': 'task type is required (purchase or delivery)',
            'any.only': `task type must be one of: ${TASK_TYPES.join(', ')}`,
        }),
    fromLatitude: joi.number().allow(null).default(0),
    fromLongitude: joi.number().allow(null).default(0),
    toLatitude: joi.number().allow(null).default(0),
    toLongitude: joi.number().allow(null).default(0),
    googleMapAddressFrom: joi.string().trim().allow('', null).default(''),
    googleMapAddressTo: joi.string().trim().allow('', null).default(''),
    pickupLocation: locationSchema.allow(null).default({}),
    deliveryLocation: locationSchema.allow(null).default({}),
    paymentLocation: joi.string().trim().allow('', null).default(''),
    isClientPaidForItems: joi.boolean().allow(null).default(false),
    isDriverReimbursed: joi.boolean().allow(null).default(false),
    deliveryDescription: joi.string().trim().allow('', null).default(''),
    itemPhotoBefore: joi.string().trim().allow('', null).default(''),
    itemPhotoAfter: joi.string().trim().allow('', null).default(''),
    purchaseItems: joi.array().items(purchaseItemSchema).allow(null).default([]),
});

function validateCreateOrder(object) {
    const schema = joi.object({
        clientId: joi.string().trim().optional().allow('', null),
        // السعر الأصلي — اختياري، يُرسَل فقط لو استُخدم خصم
        originalDeliveryPrice: joi.number().min(0).allow(null).default(null),
        // السعر بعد الخصم (أو السعر العادي لو مفيش خصم)
        totalDeliveryPrice: joi.number().min(0).default(0),
        // حقول الخصم — كلها اختيارية
        discountAmount: joi.number().min(0).default(0),
        discountPercentage: joi.number().min(0).max(100).allow(null).default(null),
        discountCode: joi.string().trim().allow(null, '').default(null),
        discountType: joi
            .string()
            .trim()
            .allow(null, '')
            .default(null),

        totalPrice: joi.number().min(0).default(0),
        totalDistanceKm: joi.number().min(0).default(0),
        vehicleTypeId: joi.string().trim().allow(null, '').default(null),
        vehicleName: joi.string().trim().allow(null, '').default(null),
        vehicleTypeName: joi.string().trim().allow(null, '').default(null),
        orderType: joi.string().trim().allow(null, '').default(null),
        clientFcmToken: joi.string().trim().allow(null, '').optional(),
        tasks: joi.array().items(taskSchema).min(1).required().messages({
            'any.required': 'tasks array is required',
            'array.min': 'At least one task is required',
        }),
    });
    return schema.validate(object, { abortEarly: false, allowUnknown: true });
}

function validateCancelOrder(object) {
    const schema = joi.object({
        reason: joi.string().trim().min(1).max(2000).required().messages({
            'any.required': 'reason is required (cancellation reason)',
            'string.min': 'reason cannot be empty',
            'string.max': 'reason is too long (max 2000 characters)',
        }),
    });
    return schema.validate(object, { abortEarly: false });
}

module.exports = {
    Order,
    ORDER_STATUSES,
    TASK_STATUSES,
    TASK_TYPES,
    getNextTaskId,
    getNextGlobalOrderId,
    validateCreateOrder,
    validateCancelOrder,
    migrateOrderStatusFromNumbersToStrings,
    migrateUnifiedOrderIds,
};

