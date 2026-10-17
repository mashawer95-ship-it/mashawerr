/**
 * One-off, batched, resumable backfill: copy the client's governorate onto legacy orders
 * that have no `governorate`. After it finishes, set ORDER_GOV_BACKFILLED=true so the API
 * stops doing the per-request user lookup.
 *
 * Usage:  node scripts/backfill_order_governorate.js [--dry-run]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { Order } = require('../middlewares/Order');
const { User } = require('../middlewares/User');

const BATCH = 500;
const DRY = process.argv.includes('--dry-run');

(async () => {
    await mongoose.connect(process.env.MONGO_URI, { maxPoolSize: 5 });
    const missing = { $or: [{ governorate: null }, { governorate: '' }, { governorate: { $exists: false } }] };
    let lastId = null;
    let scanned = 0;
    let updated = 0;

    for (;;) {
        const q = lastId ? { $and: [missing, { _id: { $gt: lastId } }] } : missing;
        const orders = await Order.find(q).sort({ _id: 1 }).limit(BATCH)
            .select('_id clientId userId').lean();
        if (orders.length === 0) break;
        lastId = orders[orders.length - 1]._id;
        scanned += orders.length;

        const keys = [...new Set(orders.flatMap((o) => [o.clientId, o.userId]).filter(Boolean).map(String))];
        const objectIds = keys.filter((k) => mongoose.isValidObjectId(k));
        const users = await User.find({ $or: [{ _id: { $in: objectIds } }, { phone: { $in: keys } }] })
            .select('_id phone governorate').lean();
        const govByKey = new Map();
        for (const u of users) {
            if (!u.governorate) continue;
            govByKey.set(String(u._id), u.governorate);
            if (u.phone) govByKey.set(String(u.phone), u.governorate);
        }

        const ops = [];
        for (const o of orders) {
            const gov = govByKey.get(String(o.clientId)) || govByKey.get(String(o.userId));
            if (gov) ops.push({ updateOne: { filter: { _id: o._id }, update: { $set: { governorate: gov } } } });
        }
        if (ops.length && !DRY) await Order.bulkWrite(ops, { ordered: false });
        updated += ops.length;
        console.log(`scanned=${scanned} updated=${updated}${DRY ? ' (dry-run)' : ''}`);
    }

    console.log('Done.');
    await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
