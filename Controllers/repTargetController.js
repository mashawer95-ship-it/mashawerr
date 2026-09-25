const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const {
    RepTarget,
    RepTargetAchievement,
    getPeriodKey,
    getPeriodRange,
    validateUpsertTarget,
    validateUpsertGlobalTarget,
} = require('../middlewares/RepTarget');
const { Order } = require('../middlewares/Order');
// StoreOrder removed – delivery-only
const { User } = require('../middlewares/User');
const { getOrCreateWallet, creditWallet } = require('../middlewares/Wallet');

// ─── Helper: fils → KWD ───────────────────────────────────────────────────────
function filsToKwd(fils) {
    return Number((fils / 1000).toFixed(3));
}

// ─── Helper: Count completed orders for a rep in a date range ─────────────────
async function countCompletedOrders(repIdStr, start, end) {
    const dateFilter = { $gte: start, $lte: end };
    const repMatch = [repIdStr];
    if (mongoose.Types.ObjectId.isValid(repIdStr)) {
        repMatch.push(new mongoose.Types.ObjectId(repIdStr));
    }
    const completedStatuses = ['completed', 'Completed', 'COMPLETED', 'delivered', 'Delivered', 'DELIVERED', 2];

    return await Order.countDocuments({ representativeId: { $in: repMatch }, status: { $in: completedStatuses }, updatedAt: dateFilter });
}

// ─── Helper: Count global completed orders in a date range ───────────────────
async function countGlobalCompletedOrders(start, end) {
    const dateFilter = { $gte: start, $lte: end };
    const completedStatuses = ['completed', 'Completed', 'COMPLETED', 'delivered', 'Delivered', 'DELIVERED', 2];

    return await Order.countDocuments({ status: { $in: completedStatuses }, updatedAt: dateFilter });
}

// ─── Helper: Build progress for a single target ───────────────────────────────
async function buildTargetProgress(target, repIdStr, now = new Date(), customStart = null, customEnd = null) {
    const effStart = customStart || (target.startDate ? target.startDate.toISOString() : null);
    const effEnd = customEnd || (target.endDate ? target.endDate.toISOString() : null);

    const { start, end } = getPeriodRange(target.period, now, effStart, effEnd);
    const periodKey = (effStart && effEnd)
        ? `${new Date(effStart).toISOString()} to ${new Date(effEnd).toISOString()}`
        : getPeriodKey(target.period, now);

    const completedCount = repIdStr
        ? await countCompletedOrders(repIdStr, start, end)
        : await countGlobalCompletedOrders(start, end);

    const isAchieved = completedCount >= target.targetCount;
    const progressPct = Math.min(100, Math.round((completedCount / target.targetCount) * 100));
    const isExpired = end ? (now > end) : false;
    const isCurrentShift = (start && end) ? (now >= start && now <= end) : false;
    const isUpcoming = start ? (now < start) : false;

    let alreadyRewarded = false;
    if (repIdStr && isAchieved) {
        const achievement = await RepTargetAchievement.findOne({
            repId: new mongoose.Types.ObjectId(repIdStr),
            targetId: target._id,
            periodKey,
        }).lean();
        alreadyRewarded = !!achievement;
    }

    return {
        targetId: target._id,
        repId: target.repId || null,
        period: target.period,
        periodKey,
        periodRange: { start, end },
        startDate: start ? start.toISOString() : null,
        endDate: end ? end.toISOString() : null,
        isExpired,
        isCurrentShift,
        isUpcoming,
        targetCount: target.targetCount,
        rewardFils: target.rewardFils,
        rewardKWD: filsToKwd(target.rewardFils),
        completedCount,
        progressPct,
        isAchieved,
        alreadyRewarded,
        isActive: target.isActive,
        notes: target.notes || '',
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDIVIDUAL TARGET ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @desc   Admin: Upsert (create or update) an individual target for a rep
 * @route  POST /api/rep-targets/rep/:repId
 * @body   { period, targetCount, rewardFils, notes }
 * @access Admin
 */
const upsertRepTarget = asyncHandler(async (req, res) => {
    const { repId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(repId)) {
        return res.status(400).json({ message: 'Invalid repId' });
    }

    const { error, value } = validateUpsertTarget(req.body);
    if (error) {
        return res.status(400).json({ message: error.details.map(d => d.message).join('; ') });
    }

    const rep = await User.findById(repId).select('firstName lastName userType').lean();
    if (!rep) return res.status(404).json({ message: 'Representative not found' });

    // Deactivate existing target for this rep + period if requested
    if (req.body.deactivateOthers === true) {
        await RepTarget.updateMany(
            { repId: new mongoose.Types.ObjectId(repId), period: value.period, isActive: true },
            { $set: { isActive: false } }
        );
    }

    let targetStart = value.startDate ? new Date(value.startDate) : null;
    let targetEnd = value.endDate ? new Date(value.endDate) : null;
    if (!targetStart || !targetEnd || isNaN(targetStart.getTime()) || isNaN(targetEnd.getTime())) {
        const defaultRange = getPeriodRange(value.period, new Date());
        targetStart = defaultRange.start;
        targetEnd = defaultRange.end;
    }

    let target = null;
    if (req.body.targetId && mongoose.Types.ObjectId.isValid(req.body.targetId)) {
        target = await RepTarget.findByIdAndUpdate(
            req.body.targetId,
            {
                $set: {
                    period: value.period,
                    targetCount: value.targetCount,
                    rewardFils: value.rewardFils,
                    startDate: targetStart,
                    endDate: targetEnd,
                    notes: value.notes || '',
                    isActive: true,
                },
            },
            { new: true }
        );
    }

    if (!target) {
        target = await RepTarget.create({
            repId: new mongoose.Types.ObjectId(repId),
            period: value.period,
            targetCount: value.targetCount,
            rewardFils: value.rewardFils,
            startDate: targetStart,
            endDate: targetEnd,
            notes: value.notes || '',
            isActive: true,
            createdBy: req.user?._id?.toString() || 'admin',
        });
    }

    return res.status(201).json({
        message: 'تم ضبط التارجت بنجاح',
        target: {
            _id: target._id,
            repId: target.repId,
            repName: `${rep.firstName} ${rep.lastName}`.trim(),
            period: target.period,
            targetCount: target.targetCount,
            rewardFils: target.rewardFils,
            rewardKWD: filsToKwd(target.rewardFils),
            startDate: target.startDate ? target.startDate.toISOString() : null,
            endDate: target.endDate ? target.endDate.toISOString() : null,
            notes: target.notes,
            isActive: target.isActive,
            createdAt: target.createdAt,
        },
    });
});

const { sanitizeErrorResponse } = require('../middlewares/objectAuthorization');

/**
 * @desc   Admin: Get individual targets for a rep with real-time progress + wallet balance
 * @route  GET /api/rep-targets/rep/:repId
 * @query  period (optional filter)
 * @access Admin
 */
const getRepTargets = asyncHandler(async (req, res) => {
    const { repId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(repId)) {
        return res.status(400).json({ message: 'Invalid repId' });
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (req.user?.id?.toString() !== repId && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    const rep = await User.findById(repId).select('firstName lastName email phone profileImage userType isAvailable').lean();
    if (!rep) return res.status(404).json({ message: 'Representative not found' });

    const filter = { repId: new mongoose.Types.ObjectId(repId), isActive: true };
    if (req.query.period) filter.period = req.query.period;

    const targets = await RepTarget.find(filter).sort({ createdAt: -1 }).lean();

    const refDate = req.query.date ? new Date(req.query.date) : new Date();
    const now = isNaN(refDate.getTime()) ? new Date() : refDate;
    const progressList = await Promise.all(
        targets.map(t => buildTargetProgress(t, repId, now))
    );

    // Wallet balance
    const wallet = await getOrCreateWallet(repId);

    return res.status(200).json({
        repId,
        repName: `${rep.firstName} ${rep.lastName}`.trim(),
        repInfo: {
            email: rep.email,
            phone: rep.phone || null,
            userType: rep.userType,
            isAvailable: rep.isAvailable,
            profileImage: rep.profileImage || null,
        },
        wallet: {
            balanceFils: wallet.balanceFils,
            balanceKWD: filsToKwd(wallet.balanceFils),
        },
        targets: progressList,
    });
});

/**
 * @desc   Admin: Delete (deactivate) a specific period target for a rep
 * @route  DELETE /api/rep-targets/rep/:repId/:period
 * @access Admin
 */
const deleteRepTarget = asyncHandler(async (req, res) => {
    const { repId, period } = req.params;

    if (!mongoose.Types.ObjectId.isValid(repId)) {
        return res.status(400).json({ message: 'Invalid repId' });
    }

    const validPeriods = ['daily', 'weekly', 'monthly', 'yearly'];
    if (!validPeriods.includes(period)) {
        return res.status(400).json({ message: `period must be one of: ${validPeriods.join(', ')}` });
    }

    const result = await RepTarget.updateMany(
        { repId: new mongoose.Types.ObjectId(repId), period, isActive: true },
        { $set: { isActive: false } }
    );

    return res.status(200).json({
        message: `تم حذف تارجت ${period} للمندوب`,
        deactivatedCount: result.modifiedCount,
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GLOBAL TARGET ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @desc   Admin: Upsert global target (applies to all reps)
 * @route  POST /api/rep-targets/global
 * @body   { period, targetCount, rewardFils, notes, startDate, endDate, targetId, deactivateOthers }
 * @access Admin
 */
const upsertGlobalTarget = asyncHandler(async (req, res) => {
    const { targetId, deactivateOthers } = req.body;
    const { error, value } = validateUpsertGlobalTarget(req.body);
    if (error) {
        return res.status(400).json({ message: error.details.map(d => d.message).join('; ') });
    }

    if (deactivateOthers === true) {
        await RepTarget.updateMany(
            { repId: null, period: value.period, isActive: true },
            { $set: { isActive: false } }
        );
    }

    const rawStart = req.body.startDate || value.startDate;
    const rawEnd = req.body.endDate || value.endDate;
    let targetStart = rawStart ? new Date(rawStart) : null;
    let targetEnd = rawEnd ? new Date(rawEnd) : null;
    if (!targetStart || !targetEnd || isNaN(targetStart.getTime()) || isNaN(targetEnd.getTime())) {
        const defaultRange = getPeriodRange(value.period, new Date());
        targetStart = defaultRange.start;
        targetEnd = defaultRange.end;
    }

    let target = null;
    if (targetId && mongoose.Types.ObjectId.isValid(targetId)) {
        target = await RepTarget.findByIdAndUpdate(
            targetId,
            {
                $set: {
                    period: value.period,
                    targetCount: value.targetCount,
                    rewardFils: value.rewardFils,
                    startDate: targetStart,
                    endDate: targetEnd,
                    notes: value.notes || '',
                    isActive: true,
                },
            },
            { new: true }
        );
    }

    if (!target) {
        target = await RepTarget.create({
            repId: null,
            period: value.period,
            targetCount: value.targetCount,
            rewardFils: value.rewardFils,
            startDate: targetStart,
            endDate: targetEnd,
            notes: value.notes || '',
            isActive: true,
            createdBy: req.user?._id?.toString() || 'admin',
        });
    }

    return res.status(201).json({
        message: 'تم ضبط التارجت العام بنجاح',
        target: {
            _id: target._id,
            scope: 'global',
            period: target.period,
            targetCount: target.targetCount,
            rewardFils: target.rewardFils,
            rewardKWD: filsToKwd(target.rewardFils),
            startDate: target.startDate ? target.startDate.toISOString() : null,
            endDate: target.endDate ? target.endDate.toISOString() : null,
            notes: target.notes,
            isActive: target.isActive,
            createdAt: target.createdAt,
        },
    });
});

/**
 * @desc   Admin: Get global targets with overall progress
 * @route  GET /api/rep-targets/global
 * @query  period (optional filter)
 * @access Admin
 */
const getGlobalTargets = asyncHandler(async (req, res) => {
    const filter = { repId: null, isActive: true };
    if (req.query.period) filter.period = req.query.period;

    const targets = await RepTarget.find(filter).sort({ startDate: 1, createdAt: -1 }).lean();

    const now = new Date();
    const progressList = await Promise.all(
        targets.map(t => buildTargetProgress(t, null, now))
    );

    return res.status(200).json({
        scope: 'global',
        targets: progressList,
    });
});

/**
 * @desc   Admin: Delete (deactivate) a specific period global target
 * @route  DELETE /api/rep-targets/global/:period
 * @access Admin
 */
const deleteGlobalTarget = asyncHandler(async (req, res) => {
    const { period } = req.params;
    const { targetId } = req.query;

    const validPeriods = ['daily', 'weekly', 'monthly', 'yearly'];
    if (!validPeriods.includes(period)) {
        return res.status(400).json({ message: `period must be one of: ${validPeriods.join(', ')}` });
    }

    const deleteFilter = { repId: null, period, isActive: true };
    if (targetId && mongoose.Types.ObjectId.isValid(targetId)) {
        deleteFilter._id = new mongoose.Types.ObjectId(targetId);
    }

    const result = await RepTarget.updateMany(
        deleteFilter,
        { $set: { isActive: false } }
    );

    return res.status(200).json({
        message: `تم حذف التارجت العام الـ ${period} بنجاح`,
        deactivatedCount: result.modifiedCount,
    });
});

/**
 * @desc   Admin: Full summary — all reps + their individual targets + global target progress
 * @route  GET /api/rep-targets/global/progress
 * @query  period (required: daily|weekly|monthly|yearly), targetId
 * @access Admin
 */
const getGlobalProgress = asyncHandler(async (req, res) => {
    const { period = 'monthly', date, startDate, endDate, targetId } = req.query;
    const validPeriods = ['daily', 'weekly', 'monthly', 'yearly'];
    if (!validPeriods.includes(period)) {
        return res.status(400).json({ message: `period must be one of: ${validPeriods.join(', ')}` });
    }

    const refDate = date ? new Date(date) : new Date();
    const now = isNaN(refDate.getTime()) ? new Date() : refDate;

    // Fetch all active global targets for this period
    const allGlobalTargetsDoc = await RepTarget.find({ repId: null, period, isActive: true })
        .sort({ startDate: 1, createdAt: -1 })
        .lean();

    // Select primary global target (matching targetId if provided, or current shift, or first)
    let primaryGlobalTargetDoc = null;
    if (targetId && mongoose.Types.ObjectId.isValid(targetId)) {
        primaryGlobalTargetDoc = allGlobalTargetsDoc.find(t => t._id.toString() === targetId) || null;
    }
    if (!primaryGlobalTargetDoc && allGlobalTargetsDoc.length > 0) {
        primaryGlobalTargetDoc = allGlobalTargetsDoc.find(t => {
            const s = t.startDate ? new Date(t.startDate) : null;
            const e = t.endDate ? new Date(t.endDate) : null;
            return s && e && now >= s && now <= e;
        }) || allGlobalTargetsDoc[0];
    }

    const effStart = startDate || (primaryGlobalTargetDoc?.startDate ? primaryGlobalTargetDoc.startDate.toISOString() : null);
    const effEnd = endDate || (primaryGlobalTargetDoc?.endDate ? primaryGlobalTargetDoc.endDate.toISOString() : null);

    const { start, end } = getPeriodRange(period, now, effStart, effEnd);
    const periodKey = (effStart && effEnd)
        ? `${new Date(effStart).toISOString()} to ${new Date(effEnd).toISOString()}`
        : getPeriodKey(period, now);

    // Build progress for all global targets (shifts)
    const globalTargetsProgress = await Promise.all(
        allGlobalTargetsDoc.map(t => buildTargetProgress(t, null, now))
    );

    // 2. All representatives
    const reps = await User.find({
        userType: { $regex: /^representative$/i },
    }).select('_id firstName lastName email phone profileImage isAvailable').lean();

    // 3. Count completed orders per rep in this period + individual targets
    const repObjectIds = reps.map(r => r._id);
    const repStringIds = reps.map(r => r._id.toString());
    const allRepIds = [...repObjectIds, ...repStringIds];
    const completedStatuses = ['completed', 'Completed', 'COMPLETED', 'delivered', 'Delivered', 'DELIVERED', 2];

    const [ordersAgg, individualTargets] = await Promise.all([
        Order.aggregate([
            { $match: { representativeId: { $in: allRepIds }, status: { $in: completedStatuses }, updatedAt: { $gte: start, $lte: end } } },
            { $group: { _id: { $toString: '$representativeId' }, count: { $sum: 1 } } },
        ]),
        RepTarget.find({
            repId: { $in: reps.map(r => r._id) },
            period,
            isActive: true,
        }).lean(),
    ]);

    // Build count maps
    const ordersMap = {};
    ordersAgg.forEach(r => { if (r._id) ordersMap[r._id] = r.count; });
    const indTargetMap = {};
    individualTargets.forEach(t => {
        if (t.repId) indTargetMap[t.repId.toString()] = t;
    });

    // 4. Wallets
    const wallets = await mongoose.model('Wallet').find({
        userId: { $in: reps.map(r => r._id) },
    }).select('userId balanceFils').lean();
    const walletMap = {};
    wallets.forEach(w => { walletMap[w.userId?.toString()] = w; });

    // 5. Achievements this period
    const achievements = await RepTargetAchievement.find({
        periodKey,
        $or: [
            { repId: { $in: reps.map(r => r._id) } },
            { repId: { $in: reps.map(r => r._id.toString()) } },
        ],
    }).lean();
    const achievedRepIds = new Set(achievements.map(a => a.repId?.toString()));
    const achievedTargetKeySet = new Set(achievements.map(a => `${a.repId?.toString()}_${a.targetId?.toString()}`));

    // 6. Build per-rep rows
    let totalCompleted = 0;
    const repRows = reps.map(rep => {
        const repIdStr = rep._id.toString();
        const completed = ordersMap[repIdStr] || 0;
        totalCompleted += completed;

        const indTarget = indTargetMap[repIdStr] || null;
        const effectiveTarget = indTarget || primaryGlobalTargetDoc || null;

        let progressPct = 0;
        let isAchieved = false;
        let alreadyRewarded = false;

        if (effectiveTarget) {
            progressPct = Math.min(100, Math.round((completed / effectiveTarget.targetCount) * 100));
            isAchieved = completed >= effectiveTarget.targetCount;
            const targetIdStr = effectiveTarget._id?.toString();
            alreadyRewarded = achievedTargetKeySet.has(`${repIdStr}_${targetIdStr}`) || achievedRepIds.has(repIdStr);
        }

        const wallet = walletMap[repIdStr] || null;

        return {
            repId: repIdStr,
            targetId: effectiveTarget?._id?.toString() || null,
            repName: `${rep.firstName} ${rep.lastName}`.trim(),
            email: rep.email,
            phone: rep.phone || null,
            isAvailable: rep.isAvailable,
            profileImage: rep.profileImage || null,
            completedCount: completed,
            targetSource: indTarget ? 'individual' : (primaryGlobalTargetDoc ? 'global' : null),
            targetCount: effectiveTarget?.targetCount || null,
            rewardFils: effectiveTarget?.rewardFils || null,
            rewardKWD: effectiveTarget ? filsToKwd(effectiveTarget.rewardFils) : null,
            progressPct,
            isAchieved,
            alreadyRewarded,
            walletBalanceFils: wallet?.balanceFils || 0,
            walletBalanceKWD: filsToKwd(wallet?.balanceFils || 0),
        };
    });

    // Sort: achieved first, then by completedCount desc
    repRows.sort((a, b) => {
        if (b.isAchieved !== a.isAchieved) return b.isAchieved ? 1 : -1;
        return b.completedCount - a.completedCount;
    });

    // Global target summary for primary target
    let primaryGlobalProgress = null;
    if (primaryGlobalTargetDoc) {
        const globalProgressPct = Math.min(100, Math.round((totalCompleted / primaryGlobalTargetDoc.targetCount) * 100));
        primaryGlobalProgress = {
            targetId: primaryGlobalTargetDoc._id,
            period: primaryGlobalTargetDoc.period,
            periodKey,
            periodRange: { start, end },
            startDate: start ? start.toISOString() : null,
            endDate: end ? end.toISOString() : null,
            isExpired: end ? (now > end) : false,
            isCurrentShift: (start && end) ? (now >= start && now <= end) : false,
            isUpcoming: start ? (now < start) : false,
            targetCount: primaryGlobalTargetDoc.targetCount,
            rewardFils: primaryGlobalTargetDoc.rewardFils,
            rewardKWD: filsToKwd(primaryGlobalTargetDoc.rewardFils),
            totalCompletedCount: totalCompleted,
            progressPct: globalProgressPct,
            isAchieved: totalCompleted >= primaryGlobalTargetDoc.targetCount,
            notes: primaryGlobalTargetDoc.notes || '',
        };
    }

    return res.status(200).json({
        period,
        periodKey,
        periodRange: { start, end },
        globalTarget: primaryGlobalProgress,
        globalTargets: globalTargetsProgress,
        totalCompletedOrders: totalCompleted,
        totalReps: reps.length,
        reps: repRows,
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REP-FACING ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @desc   Rep: View own targets + wallet balance
 * @route  GET /api/rep-targets/my/:repId
 * @access Authenticated (self)
 */
const getMyTargets = asyncHandler(async (req, res) => {
    const { repId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(repId)) {
        return res.status(400).json({ message: 'Invalid repId' });
    }

    const isAdmin = req.user?.isAdmin === true || req.fullUser?.isAdmin === true;
    if (req.user?.id?.toString() !== repId && !isAdmin) {
        return sanitizeErrorResponse(res, true, true);
    }

    // Fetch individual + global targets
    const targets = await RepTarget.find({
        isActive: true,
        $or: [
            { repId: new mongoose.Types.ObjectId(repId) },
            { repId: null },
        ],
    }).lean();

    const refDate = req.query.date ? new Date(req.query.date) : new Date();
    const now = isNaN(refDate.getTime()) ? new Date() : refDate;
    const progressList = await Promise.all(
        targets.map(t => buildTargetProgress(t, repId, now))
    );

    // Wallet
    const wallet = await getOrCreateWallet(repId);

    // Last 10 target_reward transactions
    const rewardTxs = (wallet.transactions || [])
        .filter(t => t.type === 'target_reward')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10)
        .map(tx => ({
            amountFils: tx.amountFils,
            amountKWD: filsToKwd(tx.amountFils),
            description: tx.description,
            createdAt: tx.createdAt,
        }));

    return res.status(200).json({
        repId,
        wallet: {
            balanceFils: wallet.balanceFils,
            balanceKWD: filsToKwd(wallet.balanceFils),
        },
        targets: progressList,
        recentRewards: rewardTxs,
    });
});

// ─── POST /api/rep-targets/approve-reward ─────────────────────────────────────
/**
 * @desc   Admin: Manually approve target achievement and deposit reward into representative's wallet
 * @route  POST /api/rep-targets/approve-reward
 * @body   { repId, targetId, period, date }
 * @access Admin
 */
// ─── POST /api/rep-targets/approve-reward ─────────────────────────────────────
/**
 * @desc   Admin: Manually approve target achievement and deposit reward into representative's wallet
 * @route  POST /api/rep-targets/approve-reward
 * @body   { repId, targetId, period, date }
 * @access Admin
 */
const approveTargetReward = asyncHandler(async (req, res) => {
    try {
        const { repId, targetId, period } = req.body;
        if (!repId) {
            return res.status(400).json({ message: 'repId is required' });
        }

        const isRepObjId = mongoose.Types.ObjectId.isValid(repId);
        const repUserQuery = isRepObjId ? { _id: repId } : { _id: repId };
        const rep = await User.findOne(repUserQuery).select('firstName lastName').lean();
        if (!rep) return res.status(404).json({ message: 'المندوب غير موجود' });

        let target = null;
        if (targetId && mongoose.Types.ObjectId.isValid(targetId)) {
            target = await RepTarget.findById(targetId).lean();
        }

        const targetPeriod = period || target?.period || 'monthly';

        if (!target) {
            target = await RepTarget.findOne({
                isActive: true,
                period: targetPeriod,
                $or: [
                    ...(isRepObjId ? [{ repId: new mongoose.Types.ObjectId(repId) }] : []),
                    { repId: repId },
                    { repId: null },
                ],
            }).sort({ createdAt: -1 }).lean();
        }

        const refDate = req.body.date ? new Date(req.body.date) : new Date();
        const now = isNaN(refDate.getTime()) ? new Date() : refDate;
        const { start, end } = getPeriodRange(targetPeriod, now);
        const periodKey = getPeriodKey(targetPeriod, now);

        const targetObjId = target?._id || new mongoose.Types.ObjectId();
        let rewardFils = target?.rewardFils ?? 0;
        
        // If rewardFils not in target document, check if custom rewardFils passed in body or global target
        if (rewardFils <= 0 && req.body.rewardFils) {
            rewardFils = Number(req.body.rewardFils);
        }

        // Check if already rewarded for this periodKey
        const achievementQuery = {
            periodKey,
            $or: [
                ...(isRepObjId ? [{ repId: new mongoose.Types.ObjectId(repId) }] : []),
                { repId: String(repId) },
            ],
        };
        if (target?._id) {
            achievementQuery.targetId = target._id;
        }

        const existing = await RepTargetAchievement.findOne(achievementQuery).lean();
        if (existing) {
            return res.status(400).json({ message: 'تم إيداع مكافأة هذا التارجت للمندوب بالفعل لهذه الفترة' });
        }

        // Check completed count for period
        const completedCount = await countCompletedOrders(repId, start, end);

        // Record achievement
        const achievementRepId = isRepObjId ? new mongoose.Types.ObjectId(repId) : repId;
        await RepTargetAchievement.create({
            repId: achievementRepId,
            targetId: targetObjId,
            period: targetPeriod,
            periodKey,
            completedCount,
            rewardFils,
        });

        // Credit Wallet
        if (rewardFils > 0) {
            await creditWallet({
                userId: achievementRepId,
                amountFils: rewardFils,
                type: 'target_reward',
                description: `مكافأة تارجت ${targetPeriod} — ${completedCount} أوردر مكتمل (اعتماد الأدمن)`,
                refId: targetObjId.toString(),
                performedBy: req.user?._id?.toString() || 'admin',
            });
        }

        return res.status(200).json({
            message: `تم قبول التارجت بنجاح وإيداع ${filsToKwd(rewardFils)} KD في محفظة المندوب ${rep.firstName || ''} ${rep.lastName || ''}`.trim(),
            repId,
            rewardFils,
            rewardKWD: filsToKwd(rewardFils),
        });
    } catch (err) {
        console.error('[approveTargetReward Error]:', err);
        return res.status(400).json({ message: err.message || 'حدث خطأ أثناء اعتماد التارجت وإيداع المكافأة' });
    }
});

module.exports = {
    upsertRepTarget,
    getRepTargets,
    deleteRepTarget,
    upsertGlobalTarget,
    getGlobalTargets,
    deleteGlobalTarget,
    getGlobalProgress,
    getMyTargets,
    approveTargetReward,
};
