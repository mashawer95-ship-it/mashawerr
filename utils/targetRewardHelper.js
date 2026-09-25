/**
 * targetRewardHelper.js
 * ─────────────────────
 * Called after every order completion (completed / delivered).
 * Checks all active targets for the representative and rewards
 * their wallet if the target count has been reached for the current period.
 *
 * Usage:
 *   const { checkAndRewardTarget } = require('../utils/targetRewardHelper');
 *   await checkAndRewardTarget(repId);   // fire-and-forget, errors are swallowed
 */

const mongoose = require('mongoose');
const { Order } = require('../middlewares/Order');
// StoreOrder removed – delivery-only
const { RepTarget, RepTargetAchievement, getPeriodKey, getPeriodRange } = require('../middlewares/RepTarget');
const { creditWallet } = require('../middlewares/Wallet');
const logger = require('./logger');

/**
 * Count completed orders for a rep in a date range.
 */
async function countCompletedOrders(repIdStr, start, end) {
    const dateFilter = { $gte: start, $lte: end };
    const repMatch = [repIdStr];
    if (mongoose.Types.ObjectId.isValid(repIdStr)) {
        repMatch.push(new mongoose.Types.ObjectId(repIdStr));
    }
    const completedStatuses = ['completed', 'Completed', 'COMPLETED', 'delivered', 'Delivered', 'DELIVERED', 2];

    return await Order.countDocuments({
        representativeId: { $in: repMatch },
        status: { $in: completedStatuses },
        updatedAt: dateFilter,
    });
}

/**
 * Main function: check all active targets for a rep and credit wallet if earned.
 * @param {string|ObjectId} repId  - representative's user _id
 */
async function checkAndRewardTarget(repId) {
    if (!repId) return;

    const repIdStr = repId.toString();
    let repObjectId;
    try {
        repObjectId = new mongoose.Types.ObjectId(repIdStr);
    } catch (_) {
        logger.warn(`[TargetReward] Invalid repId: ${repIdStr}`);
        return;
    }

    try {
        // Fetch active individual targets for this rep + active global targets
        const targets = await RepTarget.find({
            isActive: true,
            $or: [
                { repId: repObjectId },
                { repId: null },
            ],
        }).lean();

        if (!targets || targets.length === 0) return;

        const now = new Date();

        for (const target of targets) {
            const { start, end } = getPeriodRange(target.period, now);
            const periodKey = getPeriodKey(target.period, now);

            // Check if already rewarded for this period
            const alreadyRewarded = await RepTargetAchievement.findOne({
                repId: repObjectId,
                targetId: target._id,
                periodKey,
            }).lean();

            if (alreadyRewarded) continue;

            // Count completed orders in this period
            const completedCount = await countCompletedOrders(repIdStr, start, end);

            if (completedCount < target.targetCount) continue;

            // ── Target achieved! Credit wallet ──
            if (target.rewardFils > 0) {
                try {
                    const wallet = await creditWallet({
                        userId: repObjectId,
                        amountFils: target.rewardFils,
                        type: 'target_reward',
                        description: `مكافأة تارجت ${target.period} — ${target.targetCount} أوردر مكتمل`,
                        refId: target._id.toString(),
                        performedBy: 'system',
                    });

                    // Record achievement to prevent re-rewarding
                    await RepTargetAchievement.create({
                        repId: repObjectId,
                        targetId: target._id,
                        period: target.period,
                        periodKey,
                        rewardFils: target.rewardFils,
                        walletTxRef: wallet._id.toString(),
                    });

                    logger.info(
                        `[TargetReward] Rep ${repIdStr} earned ${target.rewardFils} fils ` +
                        `for ${target.period} target (${target.targetCount} orders). Period: ${periodKey}`
                    );
                } catch (dupErr) {
                    // Unique index violation = already rewarded by a concurrent request
                    if (dupErr.code === 11000) {
                        logger.debug(`[TargetReward] Duplicate reward skipped for rep ${repIdStr} target ${target._id} period ${periodKey}`);
                    } else {
                        logger.error(`[TargetReward] Failed to credit wallet for rep ${repIdStr}:`, dupErr.message);
                    }
                }
            } else {
                // rewardFils = 0, just record the achievement
                try {
                    await RepTargetAchievement.create({
                        repId: repObjectId,
                        targetId: target._id,
                        period: target.period,
                        periodKey,
                        rewardFils: 0,
                        walletTxRef: null,
                    });
                } catch (dupErr) {
                    if (dupErr.code !== 11000) {
                        logger.error(`[TargetReward] Failed to record zero-reward achievement:`, dupErr.message);
                    }
                }
            }
        }
    } catch (err) {
        // Non-critical — never crash order completion due to target logic
        logger.error(`[TargetReward] Unexpected error for rep ${repIdStr}:`, err.message);
    }
}

module.exports = { checkAndRewardTarget };
