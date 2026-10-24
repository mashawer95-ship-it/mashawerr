const mongoose = require('mongoose');
const joi = require('joi');

// حد الرصيد السالب المسموح الافتراضي — -5 دينار كويتي = -5000 فلس
const DEFAULT_MIN_WALLET_FILS = -5000;

/**
 * دالة ديناميكية لجلب الحد الأدنى للرصيد السالب من إعدادات Pricing
 * إذا وضع الأدمن 3 دينار (3000 فلس)، يكون الحد السالب المسموح به -3000 فلس
 */
async function getMinWalletBalanceFils() {
    if (mongoose.connection.readyState === 0) {
        return DEFAULT_MIN_WALLET_FILS;
    }
    try {
        const { getOrCreatePricing } = require('./Pricing');
        const pricing = await getOrCreatePricing();
        const rawVal = pricing?.maxNegativeBalanceFils;
        if (rawVal === undefined || rawVal === null || rawVal === '') {
            return DEFAULT_MIN_WALLET_FILS;
        }
        let maxNegFils = Math.abs(Number(rawVal));
        if (isNaN(maxNegFils)) {
            return DEFAULT_MIN_WALLET_FILS;
        }
        // إذا قام الأدمن بإدخال 0، فالحد السالب المسموح هو 0 (ممنوع أي مديونية إطلاقاً)
        if (maxNegFils === 0) {
            return 0;
        }
        // إذا قام الأدمن بإدخال القيمة بالدينار/الجنيه (مثل 5 أو 10 أو 50 ج.م بدلاً من فلس)
        if (maxNegFils > 0 && maxNegFils < 500) {
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
    if (mongoose.connection.readyState === 0) {
        return { _id: uStr, userId: uStr, balanceFils: 0, transactions: [], save: async () => {} };
    }
    let wallet = await Wallet.findOne({ userId: uStr });
    if (!wallet && mongoose.Types.ObjectId.isValid(userId)) {
        wallet = await Wallet.findOne({ userId: new mongoose.Types.ObjectId(userId) });
    }
    if (!wallet) {
        try {
            wallet = await Wallet.create({ userId: uStr, balanceFils: 0, transactions: [] });
        } catch (err) {
            if (err.code === 11000) {
                wallet = await Wallet.findOne({ userId: uStr });
                if (!wallet && mongoose.Types.ObjectId.isValid(userId)) {
                    wallet = await Wallet.findOne({ userId: new mongoose.Types.ObjectId(userId) });
                }
            } else if (mongoose.Types.ObjectId.isValid(userId)) {
                try {
                    wallet = await Wallet.create({ userId: new mongoose.Types.ObjectId(userId), balanceFils: 0, transactions: [] });
                } catch (innerErr) {
                    if (innerErr.code === 11000) {
                        wallet = await Wallet.findOne({ userId: new mongoose.Types.ObjectId(userId) });
                    } else {
                        throw innerErr;
                    }
                }
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
        const amountKD = (Number(amountFils) / 1000).toFixed(2);
        const balanceKD = (Number(balanceAfterFils) / 1000).toFixed(2);

        let title = '💰 حركة في المحفظة';
        let body = '';

        switch (type) {
            case 'credit':
                title = '💰 تم إضافة رصيد إلى محفظتك';
                body = `تمت إضافة ${amountKD} ج.م إلى محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} ج.م`;
                break;
            case 'order_earnings':
                title = '🎉 إيداع أرباح توصيل';
                const orderRefStr = refId ? ` للطلب #${refId}` : '';
                body = `تم إيداع ${amountKD} ج.م أرباح توصيل${orderRefStr} في محفظتك. رصيدك الحالي: ${balanceKD} ج.م`;
                break;
            case 'target_reward':
                title = '🏆 مكافأة تحقيق الهدف';
                body = `تهانينا! تمت إضافة مكافأة بقيمة ${amountKD} ج.م إلى محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} ج.م`;
                break;
            case 'delay_reward':
                title = '⏰ مكافأة تأخير العميل';
                body = `تمت إضافة ${amountKD} ج.م مكافأة انتظار إلى محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} ج.م`;
                break;
            case 'cancellation_reward':
                title = '❌ تعويض إلغاء الطلب';
                body = `تمت إضافة ${amountKD} ج.م تعويض إلى محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} ج.م`;
                break;
            case 'company_commission_refund':
                title = '🔄 استرجاع عمولة الشركة';
                body = `تم استرجاع ${amountKD} ج.م إلى محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} ج.م`;
                break;
            case 'delay_fee':
                title = '⏰ خصم رسوم تأخير';
                body = `تم خصم ${amountKD} ج.م رسوم تأخير من محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} ج.م`;
                break;
            case 'cancellation_fee':
                title = '❌ خصم رسوم إلغاء';
                body = `تم خصم ${amountKD} ج.م رسوم إلغاء من محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} ج.م`;
                break;
            case 'company_commission':
                title = '🏢 خصم عمولة الشركة';
                body = `تم خصم ${amountKD} ج.م عمولة الشركة من محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} ج.م`;
                break;
            case 'debit':
                title = '💳 تم خصم مبلغ من محفظتك';
                body = `تم خصم ${amountKD} ج.م من محفظتك.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} ج.م`;
                break;
            case 'admin_adjustment':
                const descLower = (description || '').toLowerCase();
                const isCredit =
                    descLower.includes('شحن') ||
                    descLower.includes('اضاف') ||
                    descLower.includes('إضاف') ||
                    descLower.includes('ايداع') ||
                    descLower.includes('إيداع') ||
                    descLower.includes('مكاف') ||
                    descLower.includes('بونص') ||
                    (!descLower.includes('خصم') && !descLower.includes('سحب'));
                title = isCredit ? '💰 تم إضافة رصيد إلى محفظتك' : '💳 تم خصم مبلغ من محفظتك';
                body = `${isCredit ? 'تمت إضافة' : 'تم خصم'} ${amountKD} ج.م${description ? ' (' + description + ')' : ''} إلى محفظتك. رصيدك الحالي: ${balanceKD} ج.م`;
                break;
            default:
                title = '💰 تحديث في رصيد المحفظة';
                body = `تم تحديث رصيد محفظتك بمبلغ ${amountKD} ج.م.${description ? ' ' + description : ''} رصيدك الحالي: ${balanceKD} ج.م`;
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
    amountFils = Math.round(Number(amountFils));
    const wallet = await getOrCreateWallet(userId);

    // Idempotency: if refId is provided and already recorded for this transaction type, return existing
    if (refId && Array.isArray(wallet.transactions) && wallet.transactions.some(t => t.refId === String(refId) && t.type === type)) {
        return wallet;
    }

    const updated = await Wallet.findOneAndUpdate(
        { _id: wallet._id },
        {
            $inc: { balanceFils: amountFils },
            $push: {
                transactions: {
                    type,
                    amountFils,
                    description,
                    refId: refId ? String(refId) : null,
                    performedBy,
                    createdAt: new Date(),
                }
            }
        },
        { new: true }
    );

    if (!updated) {
        throw new Error(`Wallet not found for user ${userId}`);
    }

    const lastTx = updated.transactions[updated.transactions.length - 1];
    if (lastTx) {
        lastTx.balanceAfterFils = updated.balanceFils;
        await Wallet.updateOne(
            { _id: updated._id, 'transactions._id': lastTx._id },
            { $set: { 'transactions.$.balanceAfterFils': updated.balanceFils } }
        ).catch(() => {});
    }

    // مزامنة فورية مع سجل المعاملات الدائم WalletLedger ليظهر الإيداع فوراً في كشف حساب العميل بالتطبيق
    try {
        const { WalletLedger } = require('./WalletLedger');
        const ledgerRef = refId ? String(refId) : `CREDIT_${userId}_${Date.now()}`;
        const source = (type === 'cancellation_reward' || type === 'delay_reward' || type === 'target_reward')
            ? 'OTHER'
            : (performedBy === 'admin' || type === 'admin_adjustment' ? 'ADMIN_ADJUSTMENT' : 'OTHER');
        await WalletLedger.create({
            walletId: updated._id,
            userId: String(userId),
            type: 'CREDIT',
            source,
            amountFils,
            currency: 'EGP',
            balanceBeforeFils: updated.balanceFils - amountFils,
            balanceAfterFils: updated.balanceFils,
            status: 'COMPLETED',
            reference: ledgerRef,
            description: description || 'إيداع في المحفظة',
            performedBy,
        });
    } catch (ledgerErr) {
        if (ledgerErr.code !== 11000) {
            console.error('[creditWallet] WalletLedger insert error:', ledgerErr.message);
        }
    }

    dispatchWalletNotification({ userId, type, amountFils, balanceAfterFils: updated.balanceFils, description, refId });
    return updated;
}

// ─── Helper: Debit (deduct) balance — standard (no negative) ────────────────────────
async function debitWallet({ userId, amountFils, description = '', refId = null, performedBy = 'system' }) {
    if (!amountFils || amountFils <= 0) throw new Error('amountFils must be positive');
    amountFils = Math.round(Number(amountFils));
    const wallet = await getOrCreateWallet(userId);

    if (refId && Array.isArray(wallet.transactions) && wallet.transactions.some(t => t.refId === String(refId) && t.type === 'debit')) {
        return wallet;
    }

    const updated = await Wallet.findOneAndUpdate(
        {
            _id: wallet._id,
            balanceFils: { $gte: amountFils },
        },
        {
            $inc: { balanceFils: -amountFils },
            $push: {
                transactions: {
                    type: 'debit',
                    amountFils,
                    description,
                    refId: refId ? String(refId) : null,
                    performedBy,
                    createdAt: new Date(),
                }
            }
        },
        { new: true }
    );

    if (!updated) {
        const currentWallet = await Wallet.findById(wallet._id).lean();
        const avail = currentWallet?.balanceFils ?? 0;
        throw new Error(`Insufficient balance. Available: ${avail} fils, Requested: ${amountFils} fils`);
    }

    const lastTx = updated.transactions[updated.transactions.length - 1];
    if (lastTx) {
        lastTx.balanceAfterFils = updated.balanceFils;
        await Wallet.updateOne(
            { _id: updated._id, 'transactions._id': lastTx._id },
            { $set: { 'transactions.$.balanceAfterFils': updated.balanceFils } }
        ).catch(() => {});
    }

    // مزامنة فورية مع سجل المعاملات الدائم WalletLedger
    try {
        const { WalletLedger } = require('./WalletLedger');
        const ledgerRef = refId ? String(refId) : `DEBIT_${userId}_${Date.now()}`;
        await WalletLedger.create({
            walletId: updated._id,
            userId: String(userId),
            type: 'DEBIT',
            source: 'OTHER',
            amountFils,
            currency: 'EGP',
            balanceBeforeFils: updated.balanceFils + amountFils,
            balanceAfterFils: updated.balanceFils,
            status: 'COMPLETED',
            reference: ledgerRef,
            description: description || 'خصم من المحفظة',
            performedBy,
        });
    } catch (ledgerErr) {
        if (ledgerErr.code !== 11000) {
            console.error('[debitWallet] WalletLedger insert error:', ledgerErr.message);
        }
    }

    dispatchWalletNotification({ userId, type: 'debit', amountFils, balanceAfterFils: updated.balanceFils, description, refId });
    return updated;
}

// ─── Helper: Debit balance allowing negative down to dynamic limit ──────────────────
// مخصص لخصم رسوم التأخير/الإلغاء من محفظة العميل (يسمح بالسالب حتى الحد الأقصى للمديونية المحدد)
async function debitWalletAllowNegative({ userId, amountFils, type = 'debit', description = '', refId = null, performedBy = 'system', enforceLimit = false }) {
    if (!amountFils || amountFils <= 0) throw new Error('amountFils must be positive');
    amountFils = Math.round(Number(amountFils));
    const wallet = await getOrCreateWallet(userId);

    if (refId && Array.isArray(wallet.transactions) && wallet.transactions.some(t => t.refId === String(refId) && t.type === type)) {
        return wallet;
    }

    const minAllowedFils = await getMinWalletBalanceFils();
    const requiredMinBalance = minAllowedFils + amountFils;

    const query = { _id: wallet._id };
    // لا يتم حظر رسوم الإلغاء ورسوم التأخير إطلاقاً، وتُحسم دائماً لتسجيل الغرامات وتراكم المديونية بدقة
    const isPenaltyOrFee = type === 'cancellation_fee' || type === 'delay_fee';
    if (enforceLimit && !isPenaltyOrFee) {
        query.balanceFils = { $gte: requiredMinBalance };
    }

    const updated = await Wallet.findOneAndUpdate(
        query,
        {
            $inc: { balanceFils: -amountFils },
            $push: {
                transactions: {
                    type,
                    amountFils,
                    description,
                    refId: refId ? String(refId) : null,
                    performedBy,
                    createdAt: new Date(),
                }
            }
        },
        { new: true }
    );

    if (!updated) {
        const currentWallet = await Wallet.findById(wallet._id).lean();
        const limitKd = (Math.abs(minAllowedFils) / 1000).toFixed(2);
        const currentBalanceKd = ((currentWallet?.balanceFils ?? 0) / 1000).toFixed(2);
        throw new Error(`الرصيد سيتجاوز الحد الأقصى للمديونية المسموح بها (${limitKd} ج.م). الرصيد الحالي: ${currentBalanceKd} ج.م.`);
    }

    const lastTx = updated.transactions[updated.transactions.length - 1];
    if (lastTx) {
        lastTx.balanceAfterFils = updated.balanceFils;
        await Wallet.updateOne(
            { _id: updated._id, 'transactions._id': lastTx._id },
            { $set: { 'transactions.$.balanceAfterFils': updated.balanceFils } }
        ).catch(() => {});
    }

    // مزامنة فورية مع سجل المعاملات الدائم WalletLedger ليظهر الخصم فوراً في كشف حساب العميل بالتطبيق
    try {
        const { WalletLedger } = require('./WalletLedger');
        const ledgerRef = refId ? String(refId) : `DEBIT_${userId}_${Date.now()}`;
        const source = isPenaltyOrFee ? 'OTHER' : (performedBy === 'admin' ? 'ADMIN_ADJUSTMENT' : 'OTHER');
        await WalletLedger.create({
            walletId: updated._id,
            userId: String(userId),
            type: 'DEBIT',
            source,
            amountFils,
            currency: 'EGP',
            balanceBeforeFils: updated.balanceFils + amountFils,
            balanceAfterFils: updated.balanceFils,
            status: 'COMPLETED',
            reference: ledgerRef,
            description: description || 'خصم من المحفظة',
            performedBy,
        });
    } catch (ledgerErr) {
        if (ledgerErr.code !== 11000) {
            console.error('[debitWalletAllowNegative] WalletLedger insert error:', ledgerErr.message);
        }
    }

    dispatchWalletNotification({ userId, type, amountFils, balanceAfterFils: updated.balanceFils, description, refId });
    return updated;
}

/**
 * Helper to determine if a payment method is cash
 */
function isCashPaymentMethod(paymentMethod) {
    if (!paymentMethod) return true;
    const pm = String(paymentMethod).toLowerCase().trim();
    return pm === 'cash' || pm === 'كاش' || pm === 'نقدا' || pm === 'نقد';
}

/**
 * Helper to accurately extract delivery price in fils for Regular Orders (Fils / KD).
 */
function extractDeliveryPriceFils(order) {
    const raw = order.totalDeliveryPrice ?? order.deliveryPrice ?? order.totalPrice ?? 0;
    let num = Number(raw);
    if (num <= 0) return 0;
    // Values >= 5000 are already in fils (e.g. 100,000 fils = 100 EGP, 5,000 fils = 5 EGP)
    if (num >= 5000) return Math.round(num);
    // Values < 5000 are in EGP / KD (e.g. 100 EGP → 100,000 fils)
    return Math.round(num * 1000);
}

/**
 * Helper to extract full order price in fils
 * (delivery price + any purchase/item amount if representative paid)
 */
function extractFullOrderPriceFils(order) {
    if (!order) return 0;
    const deliveryFils = extractDeliveryPriceFils(order);

    let totalRaw = order.totalPrice;
    let totalNum = Number(totalRaw);
    let totalFils = 0;
    if (totalNum > 0) {
        totalFils = totalNum >= 5000 ? Math.round(totalNum) : Math.round(totalNum * 1000);
    }

    let fullOrderFils = Math.max(totalFils, deliveryFils);

    const repPaymentEgp = Number(order.representativePaymentAmount) || 0;
    if (repPaymentEgp > 0) {
        const repPaymentFils = Math.round(repPaymentEgp * 1000);
        if (fullOrderFils <= deliveryFils) {
            fullOrderFils = deliveryFils + repPaymentFils;
        }
    }

    return fullOrderFils > 0 ? fullOrderFils : deliveryFils;
}

/**
 * ─── Helper: التحقق من كفاية رصيد محفظة المندوب لعمولة الشركة دون خصم ─────
 * Pre-flight check: validates balance before atomic order acceptance without mutating the wallet.
 */
async function checkCompanyCommissionSufficient({ order, repId, wallet: walletOverride = null }) {
    if (!repId) return { allowed: true, companyFeeFils: 0 };

    const wallet = walletOverride || await getOrCreateWallet(repId);
    const minAllowedFils = await getMinWalletBalanceFils();
    const limitKd = (Math.abs(minAllowedFils) / 1000).toFixed(2);
    const currentBalanceKd = (wallet.balanceFils / 1000).toFixed(2);

    // 1. فحص أساسي إلزامي: هل رصيد المندوب الحالي وصل أو تجاوز الحد الأدنى بالسالب؟
    if (wallet.balanceFils <= minAllowedFils) {
        return {
            allowed: false,
            message: `برجاء شحن المحفظة لقبول الطلب، تم تجاوز الحد المسموح به للمديونية (${limitKd} ج.م). رصيدك الحالي: ${currentBalanceKd} ج.م`,
            code: 'INSUFFICIENT_WALLET_BALANCE',
            requiredFils: 0,
            currentBalanceFils: wallet.balanceFils,
            minBalanceFils: minAllowedFils,
            companyFeeFils: 0,
        };
    }

    if (!order) return { allowed: true, companyFeeFils: 0 };

    const deliveryPriceFils = extractDeliveryPriceFils(order);
    if (deliveryPriceFils <= 0) return { allowed: true, companyFeeFils: 0 };

    const { resolveOrderRepCommissionPct } = require('./RepCommission');
    const repCommissionPct = await resolveOrderRepCommissionPct({ order, repId });

    const companyPct = 100 - repCommissionPct;
    const companyFeeFils = Math.round((deliveryPriceFils * companyPct) / 100);

    if (companyFeeFils <= 0) {
        return { allowed: true, companyFeeFils: 0 };
    }

    // 2. فحص بعد احتساب عمولة الشركة: هل الخصم سيتجاوز الحد الأدنى بالسالب؟
    const potentialBalance = wallet.balanceFils - companyFeeFils;
    if (potentialBalance < minAllowedFils) {
        const feeKd = (companyFeeFils / 1000).toFixed(2);
        return {
            allowed: false,
            message: `برجاء شحن المحفظة لقبول الطلب، سيتم تجاوز الحد المسموح به للمديونية (${limitKd} ج.م) بخصم عمولة الطلب (${feeKd} ج.م)`,
            code: 'INSUFFICIENT_WALLET_BALANCE',
            requiredFils: companyFeeFils,
            currentBalanceFils: wallet.balanceFils,
            minBalanceFils: minAllowedFils,
            companyFeeFils,
        };
    }

    return { allowed: true, companyFeeFils };
}

/**
 * ─── Helper: الخصم التلقائي لنسبة الشركة من محفظة المندوب عند قبول الطلب ─────────────────
 * إذا كان خصم العمولة سيتجاوز الحد السالب (-5000 فلس / -5 KWD)، يمنع قبول الطلب
 * IDEMPOTENT: If already deducted for this order, returns immediately without double-debiting.
 */
async function deductCompanyCommissionOnAccept({ order, repId, isBusiness = false, wallet: walletOverride = null }) {
    if (!order || !repId) return { allowed: true, companyFeeFils: 0 };

    // Idempotency: if commission was already deducted for this order, do not deduct again
    if (order.companyCommissionDeducted) {
        return { allowed: true, companyFeeFils: order.companyCommissionFils || 0 };
    }

    const wallet = walletOverride || await getOrCreateWallet(repId);
    const minAllowedFils = await getMinWalletBalanceFils();
    const limitKd = (Math.abs(minAllowedFils) / 1000).toFixed(2);
    const currentBalanceKd = (wallet.balanceFils / 1000).toFixed(2);

    if (wallet.balanceFils <= minAllowedFils) {
        return {
            allowed: false,
            message: `برجاء شحن المحفظة لقبول الطلب، تم تجاوز الحد المسموح به للمديونية (${limitKd} ج.م). رصيدك الحالي: ${currentBalanceKd} ج.م`,
            code: 'INSUFFICIENT_WALLET_BALANCE',
            requiredFils: 0,
            currentBalanceFils: wallet.balanceFils,
            minBalanceFils: minAllowedFils,
        };
    }

    const deliveryPriceFils = extractDeliveryPriceFils(order);
    if (deliveryPriceFils <= 0) return { allowed: true, companyFeeFils: 0 };

    const { resolveOrderRepCommissionPct } = require('./RepCommission');
    const repCommissionPct = await resolveOrderRepCommissionPct({ order, repId });

    const companyPct = 100 - repCommissionPct;
    const companyFeeFils = Math.round((deliveryPriceFils * companyPct) / 100);

    if (companyFeeFils <= 0) {
        order.companyCommissionFils = 0;
        order.companyCommissionDeducted = false;
        return { allowed: true, companyFeeFils: 0 };
    }

    const potentialBalance = wallet.balanceFils - companyFeeFils;
    if (potentialBalance < minAllowedFils) {
        const feeKd = (companyFeeFils / 1000).toFixed(2);
        return {
            allowed: false,
            message: `برجاء شحن المحفظة لقبول الطلب، سيتم تجاوز الحد المسموح به للمديونية (${limitKd} ج.م) بخصم عمولة الطلب (${feeKd} ج.م)`,
            code: 'INSUFFICIENT_WALLET_BALANCE',
            requiredFils: companyFeeFils,
            currentBalanceFils: wallet.balanceFils,
            minBalanceFils: minAllowedFils,
        };
    }

    wallet.balanceFils = potentialBalance;
    const orderNum = order.orderId || order._id || '';
    const vehicleName = order.vehicleTypeName || order.vehicleName || '';
    const vehicleLabel = vehicleName ? ` (${vehicleName})` : '';
    const transDesc = `خصم نسبة الشركة (${companyPct}%)${vehicleLabel} عند قبول الطلب #${orderNum}`;
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
 * ─── Helper: استرجاع نسبة الشركة المخصومة في حال إلغاء أو إفلات الطلب أو تحويله لمراجعة / تأخير ─────
 */
async function refundCompanyCommissionOnCancelOrRelease({ order, reason = '', repId: repIdOverride = null }) {
    if (!order) return { refunded: false };

    // Refresh commission details from DB if missing on in-memory object
    if ((!order.companyCommissionFils || order.companyCommissionFils <= 0 || order.companyCommissionDeducted === undefined) && order._id) {
        try {
            const OrderModel = mongoose.models.Order || mongoose.model('Order');
            const fresh = await OrderModel.findById(order._id).select('companyCommissionDeducted companyCommissionFils representativeId orderId').lean();
            if (fresh) {
                if (fresh.companyCommissionDeducted !== undefined) order.companyCommissionDeducted = fresh.companyCommissionDeducted;
                if (fresh.companyCommissionFils !== undefined) order.companyCommissionFils = fresh.companyCommissionFils;
                if (!order.representativeId && fresh.representativeId) order.representativeId = fresh.representativeId;
            }
        } catch (_) {}
    }

    if (!order.companyCommissionDeducted || !order.companyCommissionFils || order.companyCommissionFils <= 0) {
        return { refunded: false };
    }
    const repId = repIdOverride || order.representativeId;
    if (!repId) return { refunded: false };

    try {
        const wallet = await getOrCreateWallet(repId);
        wallet.balanceFils += order.companyCommissionFils;
        const orderNum = order.orderId || order._id || '';
        const transDesc = reason || `استرجاع عمولة الشركة بعد إلغاء/إفلات الطلب #${orderNum}`;
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

        // Persist companyCommissionDeducted = false in MongoDB directly
        if (order._id) {
            try {
                const OrderModel = mongoose.models.Order || mongoose.model('Order');
                await OrderModel.findByIdAndUpdate(order._id, { companyCommissionDeducted: false });
            } catch (_) {}
        }

        return { refunded: true, amountFils: order.companyCommissionFils };
    } catch (err) {
        console.error(`[refundCompanyCommissionOnCancelOrRelease] فشل استرجاع العمولة: ${err.message}`);
        return { refunded: false, error: err.message };
    }
}

/**
 * الخصم التلقائي لرسوم التوصيل عند اكتمال الطلب (completed / delivered)
 * 1. خصم سعر التوصيل من محفظة العميل (إن وجد)
 * 2. إيداع مستحقات التوصيل للمندوب عند الاكتمال التام للطلب
 */
async function processOrderCompletionWallet(order) {
    if (!order) return;
    if (order.isWalletProcessed) return;
    if (mongoose.connection.readyState !== 1) return;

    const deliveryPriceFils = extractDeliveryPriceFils(order);
    if (deliveryPriceFils <= 0) return;

    const refId = String(order.orderId || order._id);
    let clientDebited = false;
    let driverCredited = false;

    // 1. الخصم من محفظة العميل (فقط إذا اختار العميل الدفع بمحفظة التطبيق)
    // SECURITY: Do NOT debit if paymentStatus is already 'paid' — that means the wallet
    // was already debited atomically at checkout time (via payOrderFromWallet / webhook).
    // Double-charging the same wallet order is prevented here by checking paymentStatus.
    const clientUserId = order.clientId || order.userId;
    const alreadyPaidViaCheckout = (order.paymentStatus === 'paid');
    const rawPm = String(order.paymentMethod || (Array.isArray(order.tasks) && order.tasks[0]?.paymentMethod) || 'cash').toLowerCase().trim();
    const isAppWallet = (rawPm === 'wallet' || rawPm === 'app_wallet');

    if (clientUserId && isAppWallet && !alreadyPaidViaCheckout) {
        try {
            await debitWalletAllowNegative({
                userId: clientUserId,
                amountFils: deliveryPriceFils,
                type: 'debit',
                description: `خصم قيمة توصيل الطلب #${order.orderId || ''}`,
                refId,
                performedBy: 'system',
            });
            clientDebited = true;
        } catch (err) {
            console.error(`[processOrderCompletionWallet] فشل الخصم من العميل: ${err.message}`);
        }
    }

    // Safety Net for Crash Point A: Ensure company commission was deducted
    // If the server crashed after acceptance before commission deduction, deduct it now
    if (order.representativeId && !order.companyCommissionDeducted) {
        try {
            await deductCompanyCommissionOnAccept({ order, repId: order.representativeId });
        } catch (commErr) {
            console.error(`[processOrderCompletionWallet] Safety commission deduction failed: ${commErr.message}`);
        }
    }

    // 2. إيداع مستحقات التوصيل للمندوب عند الاكتمال التام للطلب
    // ACCOUNTING INVARIANT:
    // في طلبات الكاش: يستلم المندوب كامل المبلغ كاش في يده من العميل مباشرة،
    // ونسبة الشركة تم خصمها بالفعل من محفظة المندوب عند قبول الطلب.
    // صافي ربح المندوب موجود بالفعل في جيبه كاش (المبلغ الإجمالي - عمولة الشركة).
    // لذلك، لا يتم إيداع أي مبلغ في المحفظة لطلبات الكاش تجنباً للازدواجية.
    // أما في طلبات الدفع الرقمي (محفظة تطبيق، محفظة كاش، فيزا/أونلاين):
    // فالعميل دفع للمنصة إلكترونياً، والمندوب لم يستلم أي كاش في يده،
    // ونسبة الشركة خُصمت بالفعل من محفظة المندوب عند قبول الطلب.
    // لذلك ينزل للمندوب سعر الطلب كاملاً في محفظته بعد اكتمال الطلب،
    // ليصبح صافي ما دخل محفظته: (سعر الطلب كاملاً - عمولة الشركة المخصومة عند القبول = أرباح المندوب الصافية).
    const isCashOrder = isCashPaymentMethod(rawPm);
    if (order.representativeId && !isCashOrder) {
        try {
            const { resolveOrderRepCommissionPct } = require('./RepCommission');
            const repCommissionPct = await resolveOrderRepCommissionPct({ order, repId: order.representativeId });
            const repEarningsFils = Math.round((deliveryPriceFils * repCommissionPct) / 100);
            const payoutAmountFils = extractFullOrderPriceFils(order);

            if (payoutAmountFils > 0) {
                await creditWallet({
                    userId: order.representativeId,
                    amountFils: payoutAmountFils,
                    type: 'order_earnings',
                    description: `مستحقات الطلب #${order.orderId || ''}`,
                    refId,
                    performedBy: 'system',
                });
                order.repEarningsFils = repEarningsFils;
                order.repPayoutFils = payoutAmountFils;
                driverCredited = true;
            }
        } catch (err) {
            console.error(`[processOrderCompletionWallet] فشل إيداع مستحقات المندوب: ${err.message}`);
        }
    } else if (order.representativeId && isCashOrder) {
        // Record zero digital wallet payout for cash orders (cash retained by driver in hand)
        const { resolveOrderRepCommissionPctSync } = require('./RepCommission');
        const repCommissionPct = resolveOrderRepCommissionPctSync({ order });
        const repEarningsFils = Math.round((deliveryPriceFils * repCommissionPct) / 100);
        order.repEarningsFils = repEarningsFils;
        order.repPayoutFils = 0;
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
        const currentBalanceKd = (balanceFils / 1000).toFixed(2);
        const limitKd = (Math.abs(minAllowedFils) / 1000).toFixed(2);

        return {
            canOrder,
            balanceFils,
            balanceKWD: Number((balanceFils / 1000).toFixed(2)),
            minBalanceFils: minAllowedFils,
            minBalanceKWD: Number((minAllowedFils / 1000).toFixed(2)),
            message: canOrder
                ? null
                : `تجاوز رصيدك الحد الأقصى للمديونية المسموح بها (${limitKd} ج.م). رصيدك الحالي: ${currentBalanceKd} ج.م. يرجى سداد المديونية وشحن المحفظة لإنشاء طلب جديد.`,
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
    checkCompanyCommissionSufficient,
    deductCompanyCommissionOnAccept,
    refundCompanyCommissionOnCancelOrRelease,
    processOrderCompletionWallet,
    checkWalletCanOrder,
    getMinWalletBalanceFils,
    validateCreditDebit,
    DEFAULT_MIN_WALLET_FILS,
    isCashPaymentMethod,
    extractFullOrderPriceFils,
};
