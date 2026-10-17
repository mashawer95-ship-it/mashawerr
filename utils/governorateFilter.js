/**
 * governorateFilter.js
 *
 * Builds the $or conditions used to filter orders by governorate.
 *
 * SCALE PROBLEM (old behaviour): every call loaded ALL users of the governorate
 * (potentially 100k+) and pushed their ids/phones into `$in` arrays -> huge memory,
 * huge queries, event-loop blocking.
 *
 * Orders already store `governorate` (indexed) at creation time. Once old orders are
 * back-filled (scripts/backfill_order_governorate.js) the user lookup is unnecessary.
 *
 *   ORDER_GOV_BACKFILLED=true  -> filter on Order.governorate only (fast, recommended)
 *   otherwise                  -> legacy fallback, but CAPPED to LEGACY_USER_CAP users
 *                                 so a single request can no longer exhaust the server.
 */
const { User } = require('../middlewares/User');
const { escapeRegex } = require('./escapeRegex');
const logger = require('./logger');

const LEGACY_USER_CAP = Number(process.env.GOV_LEGACY_USER_CAP) || 5000;

async function buildGovernorateConditions(govTerm) {
    const regex = new RegExp(escapeRegex(govTerm), 'i');
    const conditions = [{ governorate: { $regex: regex } }];

    if (process.env.ORDER_GOV_BACKFILLED === 'true') {
        return conditions;
    }

    const matchingUsers = await User.find({ governorate: { $regex: regex } })
        .select('_id phone')
        .limit(LEGACY_USER_CAP)
        .lean();

    if (matchingUsers.length >= LEGACY_USER_CAP) {
        logger.warn(
            `[governorateFilter] legacy user lookup capped at ${LEGACY_USER_CAP} for "${govTerm}". ` +
            'Run scripts/backfill_order_governorate.js and set ORDER_GOV_BACKFILLED=true.'
        );
    }

    const userIds = matchingUsers.map((u) => u._id.toString());
    const userPhones = matchingUsers.map((u) => u.phone).filter(Boolean);

    // Legacy orders without their own governorate are matched through the client's governorate.
    const missingGov = { $or: [{ governorate: null }, { governorate: '' }, { governorate: { $exists: false } }] };
    if (userIds.length > 0) {
        conditions.push({ $and: [missingGov, { clientId: { $in: userIds } }] });
        conditions.push({ $and: [missingGov, { userId: { $in: userIds } }] });
    }
    if (userPhones.length > 0) {
        conditions.push({ $and: [missingGov, { clientId: { $in: userPhones } }] });
        conditions.push({ $and: [missingGov, { userId: { $in: userPhones } }] });
    }
    return conditions;
}

module.exports = { buildGovernorateConditions };
