/**
 * payments/services/checkoutService.js
 * Service for CheckoutSession lifecycle — strict Payment-Before-Final-Order gate.
 *
 * Flow:
 *   1. Client submits task/route/discount details to create CheckoutSession.
 *   2. Server calculates authoritative distance & pricing (client prices are IGNORED).
 *   3. Commercial snapshot is frozen in CheckoutSession (amounts cannot be manipulated).
 *   4. Client pays:
 *      - Via Paymob (Online Card / Mobile Wallet) → verified webhook creates final Order.
 *      - Via Internal App Wallet → atomic debit creates final Order.
 *   5. Final Order is created ONLY after verified payment.
 */

'use strict';

const mongoose = require('mongoose');
const { CheckoutSession, CHECKOUT_STATUSES } = require('../../middlewares/CheckoutSession');
const { Order, validateCreateOrder } = require('../../middlewares/Order');
const { Payment, PaymentEvent } = require('../../middlewares/Payment');
const { VehicleType } = require('../../middlewares/VehicleType');
const { User } = require('../../middlewares/User');
const { getOrCreatePricing, kdToFils } = require('../../middlewares/Pricing');
const { calculateRoute } = require('../../services/googleRoutesService');
const {
    assertUserCanUseDiscountCode,
    assertUserCanUseGlobalDiscount,
} = require('../../middlewares/Discount');
const walletPaymentService = require('./walletPaymentService');
const paymobService = require('../providers/paymob/paymob.service');
const paymobConfig = require('../config/paymobConfig');
const {
    PAYMENT_ERROR_CODES,
    CHECKOUT_EXPIRY_MINUTES,
    CURRENCY,
    PAYMENT_PROVIDERS,
    ORDER_MIN_PAYMENT_FILS,
} = require('../constants/paymentConstants');
const { filsToEgpPiastres, filsToEgp, isValidFils } = require('../utils/money');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const crypto = require('crypto');
const zlib = require('zlib');
const util = require('util');
const gzipAsync = util.promisify(zlib.gzip);

/**
 * Create a new CheckoutSession with server-side frozen commercial snapshot.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {object} params.orderPayload
 * @param {string} params.requestId
 * @returns {Promise<object>} CheckoutSession summary
 */
async function createCheckoutSession({ userId, orderPayload, requestId }) {
    const userIdStr = String(userId);

    // ── 1. Check max active orders limit ─────────────────────────────────────
    const activeStatuses = ['waiting', 'accepted', 'delivering', 'confirmed', 'processing', 'shipped', 'pending'];
    const activeCount = await Order.countDocuments({
        $or: [{ clientId: userIdStr }, { userId: userIdStr }],
        status: { $in: activeStatuses },
    });

    if (activeCount >= 2) {
        throw new ApiError(
            400,
            'لقد وصلت إلى الحد الأقصى للطلبات النشطة (طلبين كحد أقصى)',
            'MAX_ACTIVE_ORDERS_REACHED'
        );
    }

    // Expire any stale sessions for this user
    await CheckoutSession.updateMany(
        {
            userId: userIdStr,
            status: { $in: ['PENDING', 'PAYMENT_PENDING'] },
            expiresAt: { $lt: new Date() },
        },
        { $set: { status: 'EXPIRED' } }
    ).catch(() => {});

    // ── 2. Validate order input structure ────────────────────────────────────
    const inputPayload = { ...orderPayload, clientId: userIdStr };
    const { error, value } = validateCreateOrder(inputPayload);
    if (error) {
        throw ApiError.badRequest(
            error.details.map((d) => d.message).join('; '),
            'VALIDATION_ERROR'
        );
    }

    // ── 3. Ladies-Only Vehicle Guard ─────────────────────────────────────────
    let targetVehicleTypeDoc = null;
    if (value.vehicleTypeId && mongoose.Types.ObjectId.isValid(value.vehicleTypeId)) {
        targetVehicleTypeDoc = await VehicleType.findById(value.vehicleTypeId).lean();
    } else if (value.vehicleName || value.vehicleTypeName) {
        const vName = (value.vehicleName || value.vehicleTypeName).trim();
        targetVehicleTypeDoc = await VehicleType.findOne({
            $or: [{ name_ar: vName }, { name_en: vName }],
        }).lean();
    }

    if (targetVehicleTypeDoc && targetVehicleTypeDoc.is_ladies_only) {
        const clientDoc = await User.findById(userIdStr).select('gender').lean();
        const normalizedGender = String(clientDoc?.gender || '').trim().toLowerCase();
        const isFemale = ['female', 'أنثى', 'انثى'].includes(normalizedGender);

        if (!isFemale) {
            throw new ApiError(
                403,
                'عذراً، هذه المركبة مخصصة حصرياً لرحلات السيدات لتوفير أقصى درجات الخصوصية والأمان.',
                'LADIES_ONLY_VEHICLE'
            );
        }
    }

    // ── 4. Validate Discounts ────────────────────────────────────────────────
    const requestedDiscountAmt = Number(value.discountAmount) || 0;
    const dtype = value.discountType ? String(value.discountType).trim() : '';

    if (requestedDiscountAmt > 0 && (dtype === 'percentage' || dtype === 'fixed') && value.discountCode) {
        const check = await assertUserCanUseDiscountCode(userIdStr, value.discountCode);
        if (!check.ok) {
            throw new ApiError(check.status, check.message, 'DISCOUNT_INVALID');
        }
    } else if (requestedDiscountAmt > 0 && dtype === 'global_discount') {
        const check = await assertUserCanUseGlobalDiscount(userIdStr);
        if (!check.ok) {
            throw new ApiError(check.status, check.message, 'DISCOUNT_INVALID');
        }
    }

    // ── 5. Server-side Route & Distance Calculation ──────────────────────────
    const waypoints = [];
    const rawAllLocs = value.allLocationsInOrder;
    if (Array.isArray(rawAllLocs) && rawAllLocs.length >= 2) {
        rawAllLocs.forEach((loc) => {
            const lat = Number(loc.lat ?? loc.latitude ?? (loc.latLng && (loc.latLng.lat ?? loc.latLng.latitude)));
            const lng = Number(loc.lng ?? loc.longitude ?? (loc.latLng && (loc.latLng.lng ?? loc.latLng.longitude)));
            if (lat && lng && !(lat === 0 && lng === 0)) {
                const lastWp = waypoints[waypoints.length - 1];
                if (!lastWp || lastWp.lat !== lat || lastWp.lng !== lng) {
                    waypoints.push({ lat, lng });
                }
            }
        });
    }

    if (waypoints.length < 2) {
        const pickupWps = [];
        const dropoffWps = [];
        value.tasks.forEach((task) => {
            if (task.fromLatitude && task.fromLongitude) {
                const lastWp = pickupWps[pickupWps.length - 1];
                if (!lastWp || lastWp.lat !== task.fromLatitude || lastWp.lng !== task.fromLongitude) {
                    pickupWps.push({ lat: task.fromLatitude, lng: task.fromLongitude });
                }
            }
            if (task.toLatitude && task.toLongitude) {
                const lastWp = dropoffWps[dropoffWps.length - 1];
                if (!lastWp || lastWp.lat !== task.toLatitude || lastWp.lng !== task.toLongitude) {
                    dropoffWps.push({ lat: task.toLatitude, lng: task.toLongitude });
                }
            }
        });
        waypoints.push(...pickupWps, ...dropoffWps);
    }

    let routeStatus = 'FAILED';
    let distanceMeters = 0;
    let fullRouteDistanceMeters = 0;
    const routeSnapshot = {
        schemaVersion: 1,
        encodedPolyline: null,
        compression: 'none',
        routeChecksum: null,
        distanceMeters: 0,
        durationSeconds: 0,
        routeCreatedAt: new Date(),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        polylineQuality: 'HIGH_QUALITY',
        polylineEncoding: 'ENCODED_POLYLINE',
        provider: 'google',
        providerVersion: 'v2',
    };

    if (waypoints.length >= 2) {
        try {
            const origin = waypoints[0];
            const destination = waypoints[waypoints.length - 1];
            const intermediates = waypoints.slice(1, -1);
            const routeData = await calculateRoute(origin, destination, {
                forceRefresh: true,
                intermediates,
            });

            if (routeData && routeData.encodedPolyline) {
                fullRouteDistanceMeters = routeData.distanceMeters || 0;
                distanceMeters = fullRouteDistanceMeters;
                routeSnapshot.distanceMeters = fullRouteDistanceMeters;
                routeSnapshot.durationSeconds = routeData.durationSeconds || 0;
                if (routeData.legPolylines && routeData.legPolylines.length > 0) {
                    routeSnapshot.legPolylines = routeData.legPolylines;
                }
                routeSnapshot.routeChecksum = crypto.createHash('md5').update(routeData.encodedPolyline).digest('hex');

                const polySize = Buffer.byteLength(routeData.encodedPolyline, 'utf8');
                if (polySize > 8192) {
                    const zipped = await gzipAsync(routeData.encodedPolyline);
                    routeSnapshot.encodedPolyline = zipped.toString('base64');
                    routeSnapshot.compression = 'gzip';
                } else {
                    routeSnapshot.encodedPolyline = routeData.encodedPolyline;
                    routeSnapshot.compression = 'none';
                }
                routeStatus = 'READY';
            }
        } catch (routeErr) {
            logger.warn('[CheckoutService] Route calculation failed', {
                requestId, err: routeErr.message,
            });
        }
    }

    // Security: Multi-waypoint delivery orders require authoritative route calculation.
    // Unverified client distance or client-estimated price must NEVER be trusted for financial checkout.
    if (waypoints.length >= 2 && (routeStatus !== 'READY' || distanceMeters <= 0)) {
        throw new ApiError(
            422,
            'تعذر احتساب مسافة المسار بدقة لإنشاء جلسة الدفع. يرجى التأكد من صحة المواقع وإعادة المحاولة.',
            PAYMENT_ERROR_CODES.ROUTE_CALCULATION_FAILED || 'ROUTE_CALCULATION_FAILED'
        );
    }

    // ── 6. Authoritative Pricing Calculation (in fils) ───────────────────────
    let pricingDoc = targetVehicleTypeDoc;
    if (!pricingDoc) {
        pricingDoc = await getOrCreatePricing();
    }

    const baseFareFils      = kdToFils(pricingDoc.baseFare ?? 0);
    const pricePerMeterFils = kdToFils(pricingDoc.pricePerMeter ?? 0);
    const minFareFils       = kdToFils(pricingDoc.minFare ?? 0);
    const surgeMultiplier   = pricingDoc.surgeMultiplier || 1;
    const numTasks          = Math.max(1, value.tasks?.length || 1);

    // Authoritative server-verified distance only
    const pricingDistanceMeters = distanceMeters > 0 ? distanceMeters : 0;

    let computedDistancePriceFils = pricingDistanceMeters * pricePerMeterFils;
    let computedOriginalPriceFils = Math.round(((baseFareFils * numTasks) + computedDistancePriceFils) * surgeMultiplier);
    // Align to nearest integer piastre (10 fils = 1 piastre = 0.01 EGP)
    computedOriginalPriceFils = Math.round(computedOriginalPriceFils / 10) * 10;

    if (computedOriginalPriceFils < minFareFils) {
        computedOriginalPriceFils = minFareFils;
    }
    if (computedOriginalPriceFils < ORDER_MIN_PAYMENT_FILS) {
        computedOriginalPriceFils = ORDER_MIN_PAYMENT_FILS;
    }

    // Apply discount
    let discountAmountFils = 0;
    if (requestedDiscountAmt > 0) {
        if (dtype === 'percentage' && value.discountPercentage > 0) {
            discountAmountFils = Math.round((computedOriginalPriceFils * value.discountPercentage) / 100);
        } else {
            discountAmountFils = Math.min(requestedDiscountAmt, computedOriginalPriceFils);
        }
        discountAmountFils = Math.round(discountAmountFils / 10) * 10;
    }

    let totalDeliveryPriceFils = Math.max(ORDER_MIN_PAYMENT_FILS, computedOriginalPriceFils - discountAmountFils);
    // Ensure final amount is always clean integer piastres (multiple of 10 fils)
    totalDeliveryPriceFils = Math.round(totalDeliveryPriceFils / 10) * 10;

    if (!isValidFils(totalDeliveryPriceFils)) {
        throw new ApiError(422, 'مبلغ التوصيل المحسوب غير صالح', PAYMENT_ERROR_CODES.ORDER_NOT_PAYABLE);
    }

    // ── 7. Map Payment Method ────────────────────────────────────────────────
    let sessionPaymentMethod = 'CARD';
    const clientPm = String(value.paymentMethod || '').toLowerCase();
    if (clientPm === 'wallet' || clientPm === 'app_wallet') {
        sessionPaymentMethod = 'APP_WALLET';
    } else if (clientPm === 'mobile_wallet') {
        sessionPaymentMethod = 'MOBILE_WALLET';
    } else if (clientPm === 'cash') {
        sessionPaymentMethod = 'CASH';
    }

    // ── 8. Freeze Commercial Snapshot in CheckoutSession ─────────────────────
    const orderSnapshot = {
        ...value,
        totalDeliveryPrice: totalDeliveryPriceFils,
        originalDeliveryPrice: computedOriginalPriceFils,
        discountAmount: discountAmountFils,
        totalPrice: totalDeliveryPriceFils,
        totalDistanceKm: (distanceMeters / 1000).toFixed(2),
        routeStatus,
        routeSnapshot,
    };

    const expiresAt = new Date(Date.now() + CHECKOUT_EXPIRY_MINUTES * 60 * 1000);

    const session = new CheckoutSession({
        userId:                   userIdStr,
        status:                   'PENDING',
        paymentMethod:            sessionPaymentMethod,
        totalDeliveryPriceFils,
        originalDeliveryPriceFils: computedOriginalPriceFils,
        discountAmountFils,
        discountCode:             value.discountCode || null,
        discountType:             value.discountType || null,
        discountPercentage:       value.discountPercentage || null,
        orderSnapshot,
        vehicleTypeId:            value.vehicleTypeId ? String(value.vehicleTypeId) : null,
        orderCategory:            value.orderCategory || (value.orderType === 'passenger' ? 'passenger' : (value.orderType === 'purchase' ? 'purchase' : 'delivery')),
        governorate:              value.governorate || null,
        expiresAt,
    });

    await session.save();

    logger.info('[CheckoutService] CheckoutSession created', {
        requestId,
        sessionId: session._id,
        userId: userIdStr,
        totalDeliveryPriceFils,
        paymentMethod: sessionPaymentMethod,
    });

    return {
        sessionId:                 session._id,
        status:                    session.status,
        paymentMethod:             session.paymentMethod,
        totalDeliveryPriceFils:    session.totalDeliveryPriceFils,
        totalDeliveryPriceEgp:     filsToEgp(session.totalDeliveryPriceFils),
        originalDeliveryPriceFils: session.originalDeliveryPriceFils,
        originalDeliveryPriceEgp:  filsToEgp(session.originalDeliveryPriceFils),
        discountAmountFils:        session.discountAmountFils,
        discountAmountEgp:         filsToEgp(session.discountAmountFils),
        expiresAt:                 session.expiresAt,
    };
}

/**
 * Get CheckoutSession details.
 */
async function getCheckoutSession({ sessionId, userId }) {
    const session = await CheckoutSession.findById(sessionId).lean();
    if (!session) {
        throw new ApiError(404, 'جلسة الدفع غير موجودة', PAYMENT_ERROR_CODES.CHECKOUT_NOT_FOUND);
    }

    if (String(session.userId) !== String(userId)) {
        throw new ApiError(403, 'غير مسموح بالوصول إلى هذه الجلسة', PAYMENT_ERROR_CODES.CHECKOUT_UNAUTHORIZED);
    }

    if (session.status === 'PENDING' && session.expiresAt < new Date()) {
        await CheckoutSession.findByIdAndUpdate(sessionId, { $set: { status: 'EXPIRED' } });
        session.status = 'EXPIRED';
    }

    // Self-healing: if session is still pending but linked Payment was already marked PAID
    if ((session.status === 'PENDING' || session.status === 'PAYMENT_PENDING') && session.paymentId) {
        const { Payment } = require('../../middlewares/Payment');
        const paymentDoc = await Payment.findById(session.paymentId).lean();
        if (paymentDoc && paymentDoc.status === 'PAID') {
            const paymentService = require('./paymentService');
            await paymentService.processWebhookTransaction({
                transaction: {
                    id: paymentDoc.providerTransactionId,
                    amount_cents: paymentDoc.amountPiastres,
                    currency: paymentDoc.currency,
                    success: true,
                    pending: false,
                    is_voided: false,
                    integration_id: paymentDoc.integrationId,
                    merchant_order_id: paymentDoc.specialReference,
                    special_reference: paymentDoc.specialReference,
                },
                requestId: 'self-heal-checkout',
            }).catch(() => {});

            const refreshed = await CheckoutSession.findById(sessionId).lean();
            if (refreshed) {
                return {
                    sessionId:                 refreshed._id,
                    status:                    refreshed.status,
                    paymentMethod:             refreshed.paymentMethod,
                    totalDeliveryPriceFils:    refreshed.totalDeliveryPriceFils,
                    totalDeliveryPriceEgp:     filsToEgp(refreshed.totalDeliveryPriceFils),
                    originalDeliveryPriceFils: refreshed.originalDeliveryPriceFils,
                    originalDeliveryPriceEgp:  filsToEgp(refreshed.originalDeliveryPriceFils),
                    discountAmountFils:        refreshed.discountAmountFils,
                    discountAmountEgp:         filsToEgp(refreshed.discountAmountFils),
                    finalOrderId:              refreshed.finalOrderId,
                    finalOrderNumericId:       refreshed.finalOrderNumericId,
                    paymentId:                 refreshed.paymentId,
                    expiresAt:                 refreshed.expiresAt,
                    paidAt:                    refreshed.paidAt,
                    completedAt:               refreshed.completedAt,
                    createdAt:                 refreshed.createdAt,
                };
            }
        }
    }

    return {
        sessionId:                 session._id,
        status:                    session.status,
        paymentMethod:             session.paymentMethod,
        totalDeliveryPriceFils:    session.totalDeliveryPriceFils,
        totalDeliveryPriceEgp:     filsToEgp(session.totalDeliveryPriceFils),
        originalDeliveryPriceFils: session.originalDeliveryPriceFils,
        originalDeliveryPriceEgp:  filsToEgp(session.originalDeliveryPriceFils),
        discountAmountFils:        session.discountAmountFils,
        discountAmountEgp:         filsToEgp(session.discountAmountFils),
        finalOrderId:              session.finalOrderId,
        finalOrderNumericId:       session.finalOrderNumericId,
        paymentId:                 session.paymentId,
        expiresAt:                 session.expiresAt,
        paidAt:                    session.paidAt,
        completedAt:               session.completedAt,
        createdAt:                 session.createdAt,
    };
}

/**
 * Initiate online Paymob payment for an active CheckoutSession.
 *
 * State machine integrity:
 *  - Only transitions PENDING -> PAYMENT_PENDING atomically
 *  - Strict rejection of PROCESSING, COMPLETED, FAILED, CANCELLED, EXPIRED
 *  - Strict rejection if paymentMethod is APP_WALLET or CASH
 *  - Reuses existing PENDING payment if already in PAYMENT_PENDING (idempotent)
 */
async function payCheckoutSessionOnline({ sessionId, userId, paymentMethod = 'CARD', requestId }) {
    const session = await CheckoutSession.findById(sessionId);
    if (!session) {
        throw new ApiError(404, 'جلسة الدفع غير موجودة', PAYMENT_ERROR_CODES.CHECKOUT_NOT_FOUND);
    }

    if (String(session.userId) !== String(userId)) {
        throw new ApiError(403, 'غير مصرح لك بالدفع لهذه الجلسة', PAYMENT_ERROR_CODES.CHECKOUT_UNAUTHORIZED);
    }

    if (session.status === 'COMPLETED') {
        throw new ApiError(409, 'تم معالجة هذا الدفع بالفعل', PAYMENT_ERROR_CODES.CHECKOUT_ALREADY_COMPLETED);
    }

    if (session.status === 'PROCESSING') {
        throw new ApiError(409, 'جلسة الدفع قيد المعالجة حالياً من خلال طريقة دفع أخرى', PAYMENT_ERROR_CODES.CHECKOUT_ALREADY_COMPLETED);
    }

    if (session.paymentMethod === 'APP_WALLET') {
        throw new ApiError(409, 'طريقة الدفع في هذه الجلسة مخصصة لمحفظة التطبيق', PAYMENT_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE);
    }

    if (session.paymentMethod === 'CASH') {
        throw new ApiError(422, 'طريقة الدفع في هذه الجلسة مخصصة للدفع نقداً (كاش)', PAYMENT_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE);
    }

    if (session.status === 'FAILED' || session.status === 'CANCELLED') {
        throw new ApiError(422, 'جلسة الدفع ملغية أو فاشلة', PAYMENT_ERROR_CODES.CHECKOUT_NOT_FOUND);
    }

    if (session.expiresAt < new Date()) {
        await CheckoutSession.findOneAndUpdate(
            { _id: sessionId, status: { $in: ['PENDING', 'PAYMENT_PENDING'] } },
            { $set: { status: 'EXPIRED' } }
        ).catch(() => {});
        throw new ApiError(422, 'انتهت صلاحية جلسة الدفع', PAYMENT_ERROR_CODES.CHECKOUT_EXPIRED);
    }

    const { User: UserModel } = require('../../middlewares/User');
    const user = await UserModel.findById(userId).lean();
    if (!user) {
        throw new ApiError(404, 'المستخدم غير موجود', PAYMENT_ERROR_CODES.PAYMENT_UNAUTHORIZED);
    }

    if (session.totalDeliveryPriceFils < ORDER_MIN_PAYMENT_FILS) {
        throw new ApiError(
            422,
            `الحد الأدنى لدفع الطلب هو ${filsToEgp(ORDER_MIN_PAYMENT_FILS)} ج.م`,
            PAYMENT_ERROR_CODES.ORDER_NOT_PAYABLE
        );
    }

    const amountPiastres = filsToEgpPiastres(session.totalDeliveryPriceFils);

    // Idempotency: Reuse existing PENDING payment if session is in PAYMENT_PENDING and still valid
    if (session.status === 'PAYMENT_PENDING' && session.paymentId) {
        const payment = await Payment.findById(session.paymentId);
        if (payment && payment.status === 'PENDING' && payment.expiresAt > new Date()) {
            logger.info('[CheckoutService] Reusing existing pending payment for checkout session', {
                requestId, sessionId, paymentId: payment._id,
            });
            const retryRef = `${payment.specialReference}_r${Date.now()}`;
            payment.specialReference = retryRef;
            await payment.save().catch(() => {});

            const intention = await paymobService.createPaymobIntention({
                amountPiastres,
                specialReference: retryRef,
                user,
                requestId,
            });
            return {
                paymentId:    payment._id,
                status:       payment.status,
                clientSecret: intention.clientSecret,
                checkoutUrl:  intention.checkoutUrl,
                publicKey:    intention.publicKey || paymobConfig.publicKey,
                expiresAt:    intention.expiresAt,
            };
        }
    }

    const selectedPm = paymentMethod === 'MOBILE_WALLET' ? 'MOBILE_WALLET' : 'CARD';
    const selectedIntegrationId = selectedPm === 'MOBILE_WALLET' && paymobConfig.walletIntegrationId
        ? paymobConfig.walletIntegrationId
        : (paymobConfig.cardIntegrationId || paymobConfig.integrationId);

    // Atomic conditional claim: only transition from PENDING -> PAYMENT_PENDING
    const lockedSession = await CheckoutSession.findOneAndUpdate(
        {
            _id: sessionId,
            userId: String(userId),
            status: 'PENDING',
            expiresAt: { $gt: new Date() },
            paymentMethod: { $nin: ['APP_WALLET', 'CASH'] },
        },
        {
            $set: {
                status: 'PAYMENT_PENDING',
                paymentMethod: selectedPm,
            }
        },
        { new: true }
    );

    if (!lockedSession) {
        // Race condition: another request won the claim
        const currentSession = await CheckoutSession.findById(sessionId).lean();
        if (!currentSession) {
            throw new ApiError(404, 'جلسة الدفع غير موجودة', PAYMENT_ERROR_CODES.CHECKOUT_NOT_FOUND);
        }
        if (currentSession.status === 'COMPLETED' || currentSession.status === 'PROCESSING') {
            throw new ApiError(409, 'جلسة الدفع قيد المعالجة حالياً أو تم إكمالها بالفعل', PAYMENT_ERROR_CODES.CHECKOUT_ALREADY_COMPLETED);
        }
        if (currentSession.status === 'PAYMENT_PENDING' && currentSession.paymentId) {
            const existingPayment = await Payment.findById(currentSession.paymentId);
            if (existingPayment && existingPayment.status === 'PENDING' && existingPayment.expiresAt > new Date()) {
                const retryRef = `${existingPayment.specialReference}_r${Date.now()}`;
                await Payment.findByIdAndUpdate(existingPayment._id, { specialReference: retryRef }).catch(() => {});

                const intention = await paymobService.createPaymobIntention({
                    amountPiastres,
                    specialReference: retryRef,
                    user,
                    requestId,
                });
                return {
                    paymentId:    existingPayment._id,
                    status:       existingPayment.status,
                    clientSecret: intention.clientSecret,
                    checkoutUrl:  intention.checkoutUrl,
                    publicKey:    intention.publicKey || paymobConfig.publicKey,
                    expiresAt:    intention.expiresAt,
                };
            }
        }
        throw new ApiError(422, 'جلسة الدفع غير متاحة للدفع أونلاين', PAYMENT_ERROR_CODES.CHECKOUT_NOT_FOUND);
    }

    let payment = null;
    try {
        payment = new Payment({
            userId:            String(userId),
            purpose:           'ORDER_PAYMENT',
            paymentMethod:     selectedPm,
            provider:          'paymob',
            checkoutSessionId: lockedSession._id,
            amountPiastres,
            currency:          CURRENCY.EGP,
            integrationId:     selectedIntegrationId,
            status:            'PENDING',
        });
        payment.specialReference = `pay_${lockedSession._id}`;
        await payment.save();

        const intention = await paymobService.createPaymobIntention({
            amountPiastres,
            specialReference: payment.specialReference,
            user,
            paymentMethod: selectedPm,
            requestId,
        });

        await Payment.findByIdAndUpdate(payment._id, {
            providerIntentionId: intention.providerIntentionId,
            providerOrderId:     intention.providerOrderId,
            expiresAt:           intention.expiresAt,
        });

        await CheckoutSession.findOneAndUpdate(
            { _id: lockedSession._id, status: 'PAYMENT_PENDING' },
            {
                $set: {
                    paymentId:           payment._id,
                    providerIntentionId: intention.providerIntentionId,
                }
            }
        );

        return {
            paymentId:    payment._id,
            status:       'PENDING',
            clientSecret: intention.clientSecret,
            checkoutUrl:  intention.checkoutUrl,
            publicKey:    intention.publicKey || paymobConfig.publicKey,
            expiresAt:    intention.expiresAt,
        };
    } catch (err) {
        if (!payment || !payment._id) {
            await CheckoutSession.findOneAndUpdate(
                { _id: lockedSession._id, status: 'PAYMENT_PENDING', paymentId: null },
                { $set: { status: 'PENDING' } }
            ).catch(() => {});
        }
        throw err;
    }
}

/**
 * Confirm and finalize an Order from a CASH CheckoutSession.
 *
 * Security:
 *  - Enforces session ownership
 *  - Enforces paymentMethod === 'CASH' (cannot confirm CARD/WALLET as CASH)
 *  - Enforces not expired
 *  - Atomically locks session status: PENDING -> PROCESSING
 *  - Creates final order from frozen snapshot
 *  - Idempotent on retries
 */
async function confirmCashCheckoutSession({ sessionId, userId, requestId }) {
    const session = await CheckoutSession.findById(sessionId);
    if (!session) {
        throw new ApiError(404, 'جلسة الدفع غير موجودة', PAYMENT_ERROR_CODES.CHECKOUT_NOT_FOUND);
    }

    if (String(session.userId) !== String(userId)) {
        throw new ApiError(403, 'غير مصرح لك بتأكيد هذه الجلسة', PAYMENT_ERROR_CODES.CHECKOUT_UNAUTHORIZED);
    }

    if (session.status === 'COMPLETED' && session.finalOrderId) {
        logger.info('[CheckoutService] Duplicate cash confirmation (idempotent)', {
            requestId, sessionId, finalOrderId: session.finalOrderId,
        });
        return {
            orderId:        session.finalOrderId,
            orderNumericId: session.finalOrderNumericId,
            status:         'COMPLETED',
        };
    }

    if (session.status === 'FAILED' || session.status === 'CANCELLED') {
        throw new ApiError(422, 'جلسة الدفع ملغية أو فاشلة', PAYMENT_ERROR_CODES.CHECKOUT_NOT_FOUND);
    }

    if (session.expiresAt < new Date()) {
        await CheckoutSession.findByIdAndUpdate(sessionId, { $set: { status: 'EXPIRED' } });
        throw new ApiError(422, 'انتهت صلاحية جلسة الدفع', PAYMENT_ERROR_CODES.CHECKOUT_EXPIRED);
    }

    if (session.paymentMethod !== 'CASH') {
        throw new ApiError(422, 'طريقة الدفع في هذه الجلسة ليست نقداً (كاش)', PAYMENT_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE);
    }

    // Atomic session claim: only transitions PENDING -> PROCESSING
    const lockedSession = await CheckoutSession.findOneAndUpdate(
        { _id: sessionId, status: 'PENDING' },
        { $set: { status: 'PROCESSING' } },
        { new: true }
    );

    if (!lockedSession) {
        const existing = await CheckoutSession.findById(sessionId).lean();
        if (existing?.status === 'COMPLETED' && existing.finalOrderId) {
            return {
                orderId:        existing.finalOrderId,
                orderNumericId: existing.finalOrderNumericId,
                status:         'COMPLETED',
            };
        }
        throw new ApiError(409, 'جلسة الدفع قيد المعالجة حالياً أو تم إكمالها بالفعل', PAYMENT_ERROR_CODES.CHECKOUT_ALREADY_COMPLETED);
    }

    const { _createOrderFromSnapshot } = require('./walletPaymentService');
    const { consumeDiscountAfterSuccessfulOrder } = require('../../middlewares/Discount');

    let finalOrder;
    try {
        finalOrder = await _createOrderFromSnapshot({
            session: lockedSession,
            paymentId: null,
            paymentMethod: 'cash',
            requestId,
        });

        await CheckoutSession.findByIdAndUpdate(sessionId, {
            status:              'COMPLETED',
            finalOrderId:        finalOrder._id,
            finalOrderNumericId: finalOrder.orderId,
            completedAt:         new Date(),
        });

        // Consume discount if applicable
        if (session.discountCode || (session.discountAmountFils && session.discountAmountFils > 0)) {
            await consumeDiscountAfterSuccessfulOrder({
                clientId:       session.userId,
                discountCode:   session.discountCode,
                discountType:   session.discountType,
                discountAmount: session.discountAmountFils,
            }).catch(() => {});
        }

        logger.info('[CheckoutService] Cash CheckoutSession confirmed and order created', {
            requestId, sessionId, orderId: finalOrder._id, orderNumericId: finalOrder.orderId,
        });

        return {
            orderId:        finalOrder._id,
            orderNumericId: finalOrder.orderId,
            status:         'COMPLETED',
            totalDeliveryPriceFils: session.totalDeliveryPriceFils,
        };
    } catch (err) {
        logger.error('[CheckoutService] Cash order creation failed — restoring session', {
            requestId, sessionId, err: err.message,
        });
        await CheckoutSession.findByIdAndUpdate(sessionId, { $set: { status: 'PENDING' } }).catch(() => {});
        throw new ApiError(500, 'فشل في إنشاء الطلب النقدي', 'ORDER_CREATION_FAILED');
    }
}

module.exports = {
    createCheckoutSession,
    getCheckoutSession,
    payCheckoutSessionOnline,
    confirmCashCheckoutSession,
};
