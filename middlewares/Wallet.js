const mongoose = require('mongoose');
const joi = require('joi');

// حد الرصيد السالب المسموح الافتراضي — -5 دينار كويتي = -5000 فلس
const DEFAULT_MIN_WALLET_FILS = -5000;

/**
 * دالة ديناميكية لجلب الحد الأدنى للرصيد السالب من إعدادات Pricing
 * إذا وضع الأدمن 3 دينار (3000 فلس)، يكون الحد السالب المسموح به -3000 فلس
 */
async function getMinWalletBalanceFils() {
    try {
        const { getOrCreatePricing } = require('./Pricing');
        const pricing = await getOrCreatePricing();
        let maxNegFils = Math.abs(Number(pricing?.maxNegativeBalanceFils !== undefined ? pricing.maxNegativeBalanceFils : 5000));
        if (isNaN(maxNegFils) || maxNegFils === 0) {
            maxNegFils = 5000;
        }
        // إذا قام الأدمن بإدخال القيمة بالدينار (مثل 5 دينار بدلاً من 5000 فلس)
        if (maxNegFils > 0 && maxNegFils <= 50) {
            maxNegFils = Math.round(maxNegFils * 1000);
        }
        return -maxNegFils;
    } catch (_) {
        return DEFAULT_MIN_WALLET_FILS;
    }
}

// ─── Transaction Sub-Schema ───────────────────────────────────────────────────
const TransactionSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: [
                'credit',
                'debit',
                'target_reward',
                'admin_adjustment',
                'delay_fee',            // خصم تأخير من العميل
                'cancellation_fee',     // خصم إلغاء من العميل
                'delay_reward',         // مكافأة تأخير للمندوب
                'cancellation_reward',  // مكافأة إلغاء للمندوب
                'company_commission',        // 🚀 خصم نسبة الشركة عند قبول الطلب
                'company_commission_refund', // 🚀 استرجاع نسبة الشركة عند إلغاء/إفلات الطلب
                'order_earnings',            // 🚀 إيداع أرباح المندوب عند اكتمال الطلب
            ],
            required: true,
        },
        amountFils: {
            type: Number,
            required: true,
            min: 0,
        },
        balanceAfterFils: {
            type: Number,
            required: true,
            default: 0,
        },
        description: {
            type: String,
            trim: true,
            default: '',
        },
        // Optional reference: orderId, targetId, etc.
        refId: {
            type: String,
            trim: true,
            default: null,
        },
        // Who performed this transaction (adminId or 'system')
        performedBy: {
            type: String,
            trim: true,
            default: 'system',
        },
    },
    { timestamps: true }
);

// ─── Wallet Schema ────────────────────────────────────────────────────────────
const WalletSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.Mixed,
            required: true,
            unique: true,
            index: true,
        },
        // Balance stored in Kuwaiti Fils (integer). Divide by 1000 to get KWD.
        // يُسمح بالرصيد السالب حتى الحد المحدد في التسعير (افتراضياً -5000 فلس = -5 KWD)
        balanceFils: {
            type: Number,
            default: 0,
        },
        transactions: {
            type: [TransactionSchema],
            default: [],
        },
    },
    { timestamps: true }
);

const Wallet = mongoose.model('Wallet', WalletSchema);

// ─── Helper: Get or create wallet for a user ─────────────────────────────────
async function getOrCreateWallet(userId) {
    if (!userId) throw new Error('userId is required for wallet');
    const uStr = String(userId);
    let wallet = await Wallet.findOne({ userId: uStr });
    if (!wallet && mongoose.Types.ObjectId.isValid(userId)) {
        wallet = await Wallet.findOne({ userId: new mongoose.Types.ObjectId(userId) });
    }
    if (!wallet) {
        try {
            wallet = await Wallet.create({ userId: uStr, balanceFils: 0, transactions: [] });
        } catch (err) {
            if (mongoose.Types.ObjectId.isValid(userId)) {
                wallet = await Wallet.create({ userId: new mongoose.Types.ObjectId(userId), balanceFils: 0, transactions: [] });
            } else {
                throw err;
            }
        }
    }
    return wallet;
}

// ─── Helper: Dispatch Push/In-App Notification on Wallet Mutation ──────────
function dispatchWalletNotification({ userId, type, amountFils, balanceAfterFils, description = '', refId = null }) {
    if (!userId || !amountFils) return;
    try {
        const { notifyClient } = require('../services/notifyClient');
        const amountKD = (Number(amountFils) / 1000).toFixed(3);
        const balanceKD = (Number(balanceAfterFils) / 1000).toFixed(3);

        let title = '💰 حركة في المحفظة';
        let body = '';

        switch (type) {
            case 'credit':
                title = '💰 تم إضافة رصيد إلى محفظتك';
                body = `تمت إضافة ${amountKD} د.ك إلى محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} د.ك`;
                break;
            case 'order_earnings':
                title = '🎉 إيداع أرباح توصيل';
                const orderRefStr = refId ? ` للطلب #${refId}` : '';
                body = `تم إيداع ${amountKD} د.ك أرباح توصيل${orderRefStr} في محفظتك. رصيدك الحالي: ${balanceKD} د.ك`;
                break;
            case 'target_reward':
                title = '🏆 مكافأة تحقيق الهدف';
                body = `تهانينا! تمت إضافة مكافأة بقيمة ${amountKD} د.ك إلى محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} د.ك`;
                break;
            case 'delay_reward':
                title = '⏰ مكافأة تأخير العميل';
                body = `تمت إضافة ${amountKD} د.ك مكافأة انتظار إلى محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} د.ك`;
                break;
            case 'cancellation_reward':
                title = '❌ تعويض إلغاء الطلب';
                body = `تمت إضافة ${amountKD} د.ك تعويض إلى محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} د.ك`;
                break;
            case 'company_commission_refund':
                title = '🔄 استرجاع عمولة الشركة';
                body = `تم استرجاع ${amountKD} د.ك إلى محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} د.ك`;
                break;
            case 'delay_fee':
                title = '⏰ خصم رسوم تأخير';
                body = `تم خصم ${amountKD} د.ك رسوم تأخير من محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} د.ك`;
                break;
            case 'cancellation_fee':
                title = '❌ خصم رسوم إلغاء';
                body = `تم خصم ${amountKD} د.ك رسوم إلغاء من محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} د.ك`;
                break;
            case 'company_commission':
                title = '🏢 خصم عمولة الشركة';
                body = `تم خصم ${amountKD} د.ك عمولة الشركة من محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} د.ك`;
                break;
            case 'debit':
                title = '💳 تم خصم مبلغ من محفظتك';
                body = `تم خصم ${amountKD} د.ك من محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} د.ك`;
                break;
            case 'admin_adjustment':
                const isCredit = (description || '').includes('إضافة') || (description || '').includes('شحن');
                title = isCredit ? '⚙️ تعديل إداري (إضافة رصيد)' : '⚙️ تعديل إداري (خصم رصيد)';
                body = `${isCredit ? 'تمت إضافة' : 'تم خصم'} ${amountKD} د.ك${description ? ' (' + description + ')' : ''}. رصيدك الحالي: ${balanceKD} د.ك`;
                break;
            default:
                title = '💰 تحديث في رصيد المحفظة';
                body = `تم تحديث رصيد محفظتك بمبلغ ${amountKD} د.ك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} د.ك`;
                break;
        }

        notifyClient(
            String(userId),
            title,
            body,
            {
                type: 'wallet_update',
                transactionType: type,
                amountFils: String(amountFils),
                balanceAfterFils: String(balanceAfterFils),
                refId: refId ? String(refId) : '',
            }
        ).catch(() => {});
    } catch (err) {
        console.error(`[dispatchWalletNotification] فشل إرسال إشعار المحفظة للمستخدم ${userId}:`, err.message);
    }
}

// ─── Helper: Credit (add) balance ────────────────────────────────────────────
async function creditWallet({ userId, amountFils, type = 'credit', description = '', refId = null, performedBy = 'system' }) {
    if (!amountFils || amountFils <= 0) throw new Error('amountFils must be positive');
    const wallet = await getOrCreateWallet(userId);
    wallet.balanceFils += amountFils;
    wallet.transactions.push({
        type,
        amountFils,
        balanceAfterFils: wallet.balanceFils,
        description,
        refId,
        performedBy,
    });
    await wallet.save();
    dispatchWalletNotification({ userId, type, amountFils, balanceAfterFils: wallet.balanceFils, description, refId });
    return wallet;
}

// ─── Helper: Debit (deduct) balance — standard (no negative) ────────────────────────
async function debitWallet({ userId, amountFils, description = '', refId = null, performedBy = 'system' }) {
    if (!amountFils || amountFils <= 0) throw new Error('amountFils must be positive');
    const wallet = await getOrCreateWallet(userId);
    if (wallet.balanceFils < amountFils) {
        throw new Error(`Insufficient balance. Available: ${wallet.balanceFils} fils, Requested: ${amountFils} fils`);
    }
    wallet.balanceFils -= amountFils;
    wallet.transactions.push({
        type: 'debit',
        amountFils,
        balanceAfterFils: wallet.balanceFils,
        description,
        refId,
        performedBy,
    });
    await wallet.save();
    dispatchWalletNotification({ userId, type: 'debit', amountFils, balanceAfterFils: wallet.balanceFils, description, refId });
    return wallet;
}

// ─── Helper: Debit balance allowing negative down to dynamic limit ──────────────────
// مخصص لخصم رسوم التأخير/الإلغاء من محفظة العميل (يسمح بالسالب حتى الحد الأقصى للمديونية المحدد)
async function debitWalletAllowNegative({ userId, amountFils, type = 'debit', description = '', refId = null, performedBy = 'system' }) {
    if (!amountFils || amountFils <= 0) throw new Error('amountFils must be positive');
    const wallet = await getOrCreateWallet(userId);
    const newBalance = wallet.balanceFils - amountFils;
    const minAllowedFils = await getMinWalletBalanceFils();
    if (newBalance < minAllowedFils) {
        const limitKd = (Math.abs(minAllowedFils) / 1000).toFixed(3);
        throw new Error(`الرصيد سيتجاوز الحد الأقصى للمديونية المسموح بها (${limitKd} د.ك). الرصيد الحالي: ${wallet.balanceFils} فلس.`);
    }
    wallet.balanceFils = newBalance;
    wallet.transactions.push({
        type,
        amountFils,
        balanceAfterFils: wallet.balanceFils,
        description,
        refId,
        performedBy,
    });
    await wallet.save();
    dispatchWalletNotification({ userId, type, amountFils, balanceAfterFils: wallet.balanceFils, description, refId });
    return wallet;
}

/**
 * Helper to accurately extract delivery price in fils for both StoreOrders (KD) and Regular Orders (Fils).
 */
function extractDeliveryPriceFils(order) {
    if (!order) return 0;
    const isStore = !!(order.isBusinessOrder || order.storeOrderId || order.orderCategory === 'business' || (Array.isArray(order.items) && order.items.length > 0));

    if (isStore) {
        // StoreOrder stores deliveryPrice in KD (e.g. 1.500 KD, 0.012 KD)
        const rawKd = order.totalDeliveryPrice != null ? order.totalDeliveryPrice : (order.deliveryPrice != null ? order.deliveryPrice : order.totalPrice);
        const num = Number(rawKd) || 0;
        if (num <= 0) return 0;
        return num >= 50 ? Math.round(num) : Math.round(num * 1000);
    } else {
        // Regular Delivery Order stores totalDeliveryPrice directly in FILS (e.g. 12 fils, 1500 fils)
        if (order.totalDeliveryPrice != null && !isNaN(order.totalDeliveryPrice)) {
            return Math.round(Number(order.totalDeliveryPrice));
        }
        if (order.deliveryPrice != null && !isNaN(order.deliveryPrice)) {
            return Math.round(Number(order.deliveryPrice));
        }
        if (order.totalPrice != null && !isNaN(order.totalPrice)) {
            const num = Number(order.totalPrice);
            return num < 50 ? Math.round(num * 1000) : Math.round(num);
        }
        return 0;
    }
}

/**
 * ─── Helper: الخصم التلقائي لنسبة الشركة من محفظة المندوب عند قبول الطلب ─────────────────
 * إذا كان خصم العمولة سيتجاوز الحد السالب (-5000 فلس / -5 KWD)، يمنع قبول الطلب
 */
async function deductCompanyCommissionOnAccept({ order, repId, isBusiness = false }) {
    if (!order || !repId) return { allowed: true, companyFeeFils: 0 };

    const deliveryPriceFils = extractDeliveryPriceFils(order);
    if (deliveryPriceFils <= 0) return { allowed: true, companyFeeFils: 0 };

    const { getCachedRepCommission } = require('./RepCommission');
    const commissionCfg = await getCachedRepCommission().catch(() => null);

    let repCommissionPct = 100;
    if (commissionCfg) {
        repCommissionPct = isBusiness || order.isBusinessOrder || order.orderCategory === 'business'
            ? (commissionCfg.businessRepCommissionPct ?? 100)
            : (commissionCfg.deliveryRepCommissionPct ?? 100);
    }
    repCommissionPct = Math.max(0, Math.min(100, Number(repCommissionPct)));

    const companyPct = 100 - repCommissionPct;
    const companyFeeFils = Math.round((deliveryPriceFils * companyPct) / 100);

    if (companyFeeFils <= 0) {
        order.companyCommissionFils = 0;
        order.companyCommissionDeducted = false;
        return { allowed: true, companyFeeFils: 0 };
    }

    const wallet = await getOrCreateWallet(repId);
    const potentialBalance = wallet.balanceFils - companyFeeFils;
    const minAllowedFils = await getMinWalletBalanceFils();

    if (potentialBalance < minAllowedFils) {
        const limitKd = (Math.abs(minAllowedFils) / 1000).toFixed(3);
        return {
            allowed: false,
            message: `برجاء شحن المحفظة لقبول الطلب، تم تجاوز الحد المسموح به للمديونية (${limitKd} د.ك)`,
            code: 'INSUFFICIENT_WALLET_BALANCE',
            requiredFils: companyFeeFils,
            currentBalanceFils: wallet.balanceFils,
            minBalanceFils: minAllowedFils,
        };
    }

    wallet.balanceFils = potentialBalance;
    const orderNum = order.orderId || order.storeOrderId || order._id || '';
    const transDesc = `خصم نسبة الشركة (${companyPct}%) عند قبول الطلب #${orderNum}`;
    wallet.transactions.push({
        type: 'company_commission',
        amountFils: companyFeeFils,
        balanceAfterFils: wallet.balanceFils,
        description: transDesc,
        refId: String(orderNum),
        performedBy: 'system',
    });
    await wallet.save();
    dispatchWalletNotification({
        userId: repId,
        type: 'company_commission',
        amountFils: companyFeeFils,
        balanceAfterFils: wallet.balanceFils,
        description: transDesc,
        refId: String(orderNum),
    });

    order.companyCommissionFils = companyFeeFils;
    order.companyCommissionDeducted = true;

    return { allowed: true, companyFeeFils };
}

/**
 * ─── Helper: استرجاع نسبة الشركة المخصومة في حال إلغاء الطلب أو إفلاته قبل الاكتمال ─────
 */
async function refundCompanyCommissionOnCancelOrRelease({ order }) {
    if (!order) return;
    if (!order.companyCommissionDeducted || !order.companyCommissionFils || order.companyCommissionFils <= 0) {
        return;
    }
    const repId = order.representativeId;
    if (!repId) return;

    try {
        const wallet = await getOrCreateWallet(repId);
        wallet.balanceFils += order.companyCommissionFils;
        const orderNum = order.orderId || order.storeOrderId || order._id || '';
        const transDesc = `استرجاع عمولة الشركة بعد إلغاء/إفلات الطلب #${orderNum}`;
        wallet.transactions.push({
            type: 'company_commission_refund',
            amountFils: order.companyCommissionFils,
            balanceAfterFils: wallet.balanceFils,
            description: transDesc,
            refId: String(orderNum),
            performedBy: 'system',
        });
        await wallet.save();
        dispatchWalletNotification({
            userId: repId,
            type: 'company_commission_refund',
            amountFils: order.companyCommissionFils,
            balanceAfterFils: wallet.balanceFils,
            description: transDesc,
            refId: String(orderNum),
        });
        order.companyCommissionDeducted = false;
    } catch (err) {
        console.error(`[refundCompanyCommissionOnCancelOrRelease] فشل استرجاع العمولة: ${err.message}`);
    }
}

/**
 * الخصم التلقائي لرسوم التوصيل عند اكتمال الطلب (completed / delivered)
 * 1. خصم سعر التوصيل من محفظة العميل (إن وجد)
 * 2. إيداع أرباح التوصيل للمندوب عند الاكتمال التام للطلب
 */
async function processOrderCompletionWallet(order) {
    if (!order) return;
    if (order.isWalletProcessed) return;
    if (mongoose.connection.readyState !== 1) return;

    const deliveryPriceFils = extractDeliveryPriceFils(order);
    if (deliveryPriceFils <= 0) return;

    const refId = String(order.orderId || order.storeOrderId || order._id);
    let clientDebited = false;
    let driverCredited = false;

    // 1. الخصم من محفظة العميل (فقط إذا اختار العميل الدفع بالمحفظة)
    const clientUserId = order.clientId || order.userId;
    if (clientUserId && order.paymentMethod === 'wallet') {
        try {
            await debitWalletAllowNegative({
                userId: clientUserId,
                amountFils: deliveryPriceFils,
                type: 'debit',
                description: `خصم قيمة توصيل الطلب #${order.orderId || order.storeOrderId || ''}`,
                refId,
                performedBy: 'system',
            });
            clientDebited = true;
        } catch (err) {
            console.error(`[processOrderCompletionWallet] فشل الخصم من العميل: ${err.message}`);
        }
    }

    // 2. إيداع أرباح التوصيل للمندوب عند الاكتمال التام للطلب
    if (order.representativeId) {
        try {
            const { getCachedRepCommission } = require('./RepCommission');
            const commissionCfg = await getCachedRepCommission().catch(() => null);

            let repCommissionPct = 100;
            if (commissionCfg) {
                repCommissionPct = order.isBusinessOrder || order.orderCategory === 'business'
                    ? (commissionCfg.businessRepCommissionPct ?? 100)
                    : (commissionCfg.deliveryRepCommissionPct ?? 100);
            }
            repCommissionPct = Math.max(0, Math.min(100, Number(repCommissionPct)));

            const repEarningsFils = Math.round((deliveryPriceFils * repCommissionPct) / 100);

            if (repEarningsFils > 0) {
                await creditWallet({
                    userId: order.representativeId,
                    amountFils: repEarningsFils,
                    type: 'order_earnings',
                    description: `أرباح توصيل الطلب #${order.orderId || order.storeOrderId || ''}`,
                    refId,
                    performedBy: 'system',
                });
                order.repEarningsFils = repEarningsFils;
                driverCredited = true;
            }
        } catch (err) {
            console.error(`[processOrderCompletionWallet] فشل إيداع أرباح المندوب: ${err.message}`);
        }
    }

    if (clientDebited || driverCredited || deliveryPriceFils > 0) {
        order.isWalletProcessed = true;
        if (typeof order.save === 'function') {
            await order.save().catch(() => {});
        }
    }
}

// ─── Helper: Check if wallet allows new order creation ────────────────────────────────
// يمنع العميل من إنشاء أوردر إذا كان رصيده < الحد السالب المسموح به في إعدادات التسعير
async function checkWalletCanOrder(userId) {
    if (!userId) {
        return { canOrder: true, balanceFils: 0, balanceKWD: 0, minBalanceFils: DEFAULT_MIN_WALLET_FILS, message: null };
    }
    try {
        const uStr = String(userId).trim();
        const query = mongoose.Types.ObjectId.isValid(uStr)
            ? { $or: [{ userId: uStr }, { userId: new mongoose.Types.ObjectId(uStr) }] }
            : { userId: uStr };
        
        // جلب كافة سجلات المحفظة لهذا المستخدم
        const wallets = await Wallet.find(query);
        let balanceFils = 0;
        if (wallets && wallets.length > 0) {
            // أخذ الرصيد الأكثر مديونية (الأقل قيمة)
            balanceFils = wallets.reduce((min, w) => {
                const b = Number(w.balanceFils ?? 0);
                return b < min ? b : min;
            }, Number(wallets[0].balanceFils ?? 0));
        }

        const minAllowedFils = await getMinWalletBalanceFils();
        // يُمنع الطلب إذا وصل الرصيد إلى الحد السالب أو تجاوزه بالسالب (<= minAllowedFils)
        const canOrder = balanceFils > minAllowedFils;
        const currentBalanceKd = (balanceFils / 1000).toFixed(3);
        const limitKd = (Math.abs(minAllowedFils) / 1000).toFixed(3);

        return {
            canOrder,
            balanceFils,
            balanceKWD: Number((balanceFils / 1000).toFixed(3)),
            minBalanceFils: minAllowedFils,
            minBalanceKWD: Number((minAllowedFils / 1000).toFixed(3)),
            message: canOrder
                ? null
                : `تجاوز رصيدك الحد الأقصى للمديونية المسموح بها (${limitKd} د.ك). رصيدك الحالي: ${currentBalanceKd} د.ك. يرجى سداد المديونية وشحن المحفظة لإنشاء طلب جديد.`,
        };
    } catch (err) {
        console.error('[checkWalletCanOrder] Wallet check failed:', err.message);
        return { canOrder: true, balanceFils: 0, balanceKWD: 0, minBalanceFils: DEFAULT_MIN_WALLET_FILS, message: null };
    }
}

// ─── Joi Validators ──────────────────────────────────────────────────────────
function validateCreditDebit(obj) {
    const schema = joi.object({
        amountFils: joi.number().integer().min(1).required()
            .messages({ 'number.min': 'amountFils must be at least 1 fil' }),
        description: joi.string().trim().max(500).allow('', null).optional().default(''),
        refId: joi.string().trim().allow('', null).optional().default(null),
    });
    return schema.validate(obj, { abortEarly: false });
}

module.exports = {
    Wallet,
    getOrCreateWallet,
    creditWallet,
    debitWallet,
    debitWalletAllowNegative,
    deductCompanyCommissionOnAccept,
    refundCompanyCommissionOnCancelOrRelease,
    processOrderCompletionWallet,
    checkWalletCanOrder,
    getMinWalletBalanceFils,
    validateCreditDebit,
    DEFAULT_MIN_WALLET_FILS,
};
