const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const { Wallet, getOrCreateWallet, creditWallet, debitWallet, debitWalletAllowNegative, validateCreditDebit } = require('../middlewares/Wallet');
const { User } = require('../middlewares/User');

// ─── Helper ───────────────────────────────────────────────────────────────────
function filsToKwd(fils) {
    return Number((fils / 1000).toFixed(3));
}

function formatWallet(wallet) {
    return {
        userId: wallet.userId,
        balanceFils: wallet.balanceFils,
        balanceKWD: filsToKwd(wallet.balanceFils),
        updatedAt: wallet.updatedAt,
    };
}

function formatTransaction(tx) {
    return {
        _id: tx._id,
        type: tx.type,
        amountFils: tx.amountFils,
        amountKWD: filsToKwd(tx.amountFils),
        balanceAfterFils: tx.balanceAfterFils,
        balanceAfterKWD: filsToKwd(tx.balanceAfterFils),
        description: tx.description || '',
        refId: tx.refId || null,
        performedBy: tx.performedBy || 'system',
        createdAt: tx.createdAt,
    };
}

// ─── GET /api/wallet/admin/all ────────────────────────────────────────────────
/**
 * @desc   Admin: Get all wallets with user info
 * @route  GET /api/wallet/admin/all
 * @query  page, limit, search (name/email), minBalance, maxBalance, userType
 * @access Admin
 */
const getAllWallets = asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const skip = (page - 1) * limit;
    const { search, minBalance, maxBalance, userType, governorate } = req.query;

    // 1. Build User query filter
    const userFilter = {};
    const conditions = [];

    if (userType && userType !== 'all' && userType.trim() !== '') {
        const typeClean = userType.trim().toLowerCase();
        if (typeClean === 'client' || typeClean === 'normaluser') {
            conditions.push({
                $or: [
                    { userType: { $regex: /client|normaluser/i } },
                    { userType: null },
                    { userType: '' },
                ],
            });
        } else {
            conditions.push({
                userType: { $regex: typeClean, $options: 'i' },
            });
        }
    }

    if (governorate && governorate.trim() !== '') {
        conditions.push({
            governorate: { $regex: governorate.trim(), $options: 'i' },
        });
    }

    if (search && search.trim() !== '') {
        const term = search.trim();
        conditions.push({
            $or: [
                { firstName: { $regex: term, $options: 'i' } },
                { lastName: { $regex: term, $options: 'i' } },
                { email: { $regex: term, $options: 'i' } },
                { phone: { $regex: term, $options: 'i' } },
            ],
        });
    }

    if (conditions.length === 1) {
        Object.assign(userFilter, conditions[0]);
    } else if (conditions.length > 1) {
        userFilter.$and = conditions;
    }

    // 2. Fetch Users matching filter
    const [users, totalUsers] = await Promise.all([
        User.find(userFilter)
            .select('firstName lastName email phone userType profileImage createdAt governorate')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        User.countDocuments(userFilter),
    ]);

    // 3. Fetch existing wallets for these users
    const userIds = users.map(u => u._id);
    const wallets = await Wallet.find({ userId: { $in: userIds } }).lean();

    const walletMap = {};
    wallets.forEach(w => {
        if (w.userId) walletMap[w.userId.toString()] = w;
    });

    // 4. Combine User + Wallet information for every single user
    let enriched = users.map(user => {
        const userIdStr = user._id.toString();
        const wallet = walletMap[userIdStr] || null;
        const balanceFils = wallet?.balanceFils || 0;

        return {
            walletId: wallet?._id || null,
            userId: user._id,
            balanceFils,
            balanceKWD: filsToKwd(balanceFils),
            transactionCount: wallet?.transactions?.length || 0,
            updatedAt: wallet?.updatedAt || user.createdAt,
            user: {
                firstName: user.firstName || '',
                lastName: user.lastName || '',
                email: user.email || '',
                phone: user.phone || null,
                governorate: user.governorate || '',
                userType: user.isAdmin ? 'Admin' : (user.userType || 'NormalUser'),
                profileImage: user.profileImage || null,
            },
        };
    });

    // Optional balance filtering if requested
    if (minBalance !== undefined && !isNaN(Number(minBalance))) {
        const min = Number(minBalance);
        enriched = enriched.filter(w => w.balanceFils >= min);
    }
    if (maxBalance !== undefined && !isNaN(Number(maxBalance))) {
        const max = Number(maxBalance);
        enriched = enriched.filter(w => w.balanceFils <= max);
    }

    return res.status(200).json({
        page,
        limit,
        total: totalUsers,
        totalPages: Math.ceil(totalUsers / limit),
        wallets: enriched,
    });
});

const { sanitizeErrorResponse } = require('../middlewares/objectAuthorization');

// ─── GET /api/wallet/:userId ──────────────────────────────────────────────────
/**
 * @desc   Get wallet balance + last 50 transactions for a user
 * @route  GET /api/wallet/:userId
 * @access Admin or the user themselves
 */
const getWallet = asyncHandler(async (req, res) => {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: 'Invalid userId' });
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (req.user?.id?.toString() !== userId && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const wallet = await getOrCreateWallet(userId);

    // Return last 50 transactions in reverse chronological order
    const last50 = [...(wallet.transactions || [])]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 50)
        .map(formatTransaction);

    return res.status(200).json({
        ...formatWallet(wallet),
        recentTransactions: last50,
    });
});

// ─── GET /api/wallet/:userId/transactions ────────────────────────────────────
/**
 * @desc   Get paginated + filtered transaction history for a user
 * @route  GET /api/wallet/:userId/transactions
 * @query  page, limit, type (credit|debit|target_reward|admin_adjustment), startDate, endDate
 * @access Admin or the user themselves
 */
const getTransactions = asyncHandler(async (req, res) => {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: 'Invalid userId' });
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (req.user?.id?.toString() !== userId && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const { type, startDate, endDate } = req.query;

    const wallet = await getOrCreateWallet(userId);
    let txs = wallet.transactions || [];

    // Filter by type
    if (type) txs = txs.filter(t => t.type === type);

    // Filter by date
    if (startDate) {
        const from = new Date(startDate);
        from.setHours(0, 0, 0, 0);
        txs = txs.filter(t => new Date(t.createdAt) >= from);
    }
    if (endDate) {
        const to = new Date(endDate);
        to.setHours(23, 59, 59, 999);
        txs = txs.filter(t => new Date(t.createdAt) <= to);
    }

    // Sort newest first
    txs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = txs.length;
    const skip = (page - 1) * limit;
    const paginated = txs.slice(skip, skip + limit).map(formatTransaction);

    return res.status(200).json({
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        balanceFils: wallet.balanceFils,
        balanceKWD: filsToKwd(wallet.balanceFils),
        transactions: paginated,
    });
});

// ─── POST /api/wallet/:userId/credit ─────────────────────────────────────────
/**
 * @desc   Admin: Credit (add) balance to a user's wallet
 * @route  POST /api/wallet/:userId/credit
 * @body   { amountFils, description, refId }
 * @access Admin
 */
const creditUserWallet = asyncHandler(async (req, res) => {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: 'Invalid userId' });
    }

    const { error, value } = validateCreditDebit(req.body);
    if (error) {
        return res.status(400).json({ message: error.details.map(d => d.message).join('; ') });
    }

    // Verify user exists
    const user = await User.findById(userId).select('firstName lastName email').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    const wallet = await creditWallet({
        userId,
        amountFils: value.amountFils,
        type: 'admin_adjustment',
        description: value.description || 'شحن رصيد من الأدمن',
        refId: value.refId || null,
        performedBy: req.user?._id?.toString() || 'admin',
    });

    return res.status(200).json({
        message: 'تم شحن الرصيد بنجاح',
        userId,
        userName: `${user.firstName} ${user.lastName}`.trim(),
        creditedFils: value.amountFils,
        creditedKWD: filsToKwd(value.amountFils),
        newBalanceFils: wallet.balanceFils,
        newBalanceKWD: filsToKwd(wallet.balanceFils),
    });
});

// ─── POST /api/wallet/:userId/debit ──────────────────────────────────────────
/**
 * @desc   Admin: Debit (deduct) balance from a user's wallet
 * @route  POST /api/wallet/:userId/debit
 * @body   { amountFils, description, refId }
 * @access Admin
 */
const debitUserWallet = asyncHandler(async (req, res) => {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: 'Invalid userId' });
    }

    const { error, value } = validateCreditDebit(req.body);
    if (error) {
        return res.status(400).json({ message: error.details.map(d => d.message).join('; ') });
    }

    const user = await User.findById(userId).select('firstName lastName email').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    let wallet;
    try {
        wallet = await debitWalletAllowNegative({
            userId,
            amountFils: value.amountFils,
            description: value.description || 'خصم رصيد من الأدمن',
            refId: value.refId || null,
            performedBy: req.user?._id?.toString() || 'admin',
        });
    } catch (err) {
        return res.status(400).json({ message: err.message });
    }

    return res.status(200).json({
        message: 'تم خصم الرصيد بنجاح',
        userId,
        userName: `${user.firstName} ${user.lastName}`.trim(),
        debitedFils: value.amountFils,
        debitedKWD: filsToKwd(value.amountFils),
        newBalanceFils: wallet.balanceFils,
        newBalanceKWD: filsToKwd(wallet.balanceFils),
    });
});

// ─── GET /api/wallet/check-can-order ─────────────────────────────────────────
/**
 * @desc   Check if authenticated user can create orders based on wallet balance
 * @route  GET /api/wallet/check-can-order
 * @access Private (JWT)
 */
const checkCanOrderEndpoint = asyncHandler(async (req, res) => {
    const userId = req.user?.id || req.user?._id;
    const { checkWalletCanOrder } = require('../middlewares/Wallet');
    const result = await checkWalletCanOrder(userId);
    return res.status(200).json(result);
});

module.exports = {
    getAllWallets,
    getWallet,
    getTransactions,
    creditUserWallet,
    debitUserWallet,
    checkCanOrderEndpoint,
};
