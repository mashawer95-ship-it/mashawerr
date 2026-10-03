/**
 * orderIdResolver.js
 * Utility to resolve and cross-map order IDs between MongoDB ObjectId and numeric orderId.
 * Caches mapping in Redis to ensure high-throughput O(1) lookups.
 */

const mongoose = require('mongoose');
const { redisGet, redisSet } = require('../config/redis');

/**
 * Resolves all identifier representations for an order or trip.
 * @param {string|number} rawInput
 * @returns {Promise<{ rawId: string, mongoId: string|null, numericId: string|null, allIds: string[] }>}
 */
async function resolveOrderIds(rawInput) {
    if (rawInput == null) {
        return { rawId: '', mongoId: null, numericId: null, allIds: [] };
    }

    const rawId = String(rawInput).trim();
    if (!rawId) {
        return { rawId: '', mongoId: null, numericId: null, allIds: [] };
    }

    // 1. Check Redis cache first
    try {
        const cached = await redisGet(`order_id_map:${rawId}`);
        if (cached) {
            const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
            if (parsed && Array.isArray(parsed.allIds) && parsed.allIds.length > 0) {
                return parsed;
            }
        }
    } catch (_) {}

    let mongoId = null;
    let numericId = null;

    const isValidObjId = mongoose.isValidObjectId(rawId);
    const num = Number(rawId);
    const isNum = !isNaN(num) && num > 0;

    try {
        const Order = mongoose.models.Order || require('../models/Order');
        if (isValidObjId) {
            mongoId = rawId;
            const ord = await Order.findById(rawId).select('orderId').lean();
            if (ord && ord.orderId) {
                numericId = String(ord.orderId);
            }
        } else if (isNum) {
            numericId = String(num);
            const ord = await Order.findOne({ orderId: num }).select('_id').lean();
            if (ord && ord._id) {
                mongoId = String(ord._id);
            }
        }
    } catch (_) {}

    const allIds = Array.from(new Set([rawId, mongoId, numericId].filter(Boolean)));
    const result = { rawId, mongoId, numericId, allIds };

    // Cache in Redis for 24 hours
    try {
        for (const id of allIds) {
            await redisSet(`order_id_map:${id}`, result, 86400);
        }
    } catch (_) {}

    return result;
}

module.exports = { resolveOrderIds };
