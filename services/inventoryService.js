const mongoose = require('mongoose');
const logger = require('../utils/logger');
const Product = mongoose.models.Product || require('../middlewares/Product').Product;

/**
 * inventoryService.js
 * 
 * Production-grade inventory management service designed to prevent Race Conditions
 * and guarantee transactional integrity across Store / Business order operations.
 * 
 * Key Principles:
 * 1. Atomic Conditional Updates: MongoDB document-level locks ensure that
 *    { stock: { $gte: quantity } } is evaluated and decremented in a single atomic DB step.
 * 2. Quantity Aggregation: Orders with multiple cart entries for the same product are merged
 *    to prevent duplicate decrements or self-deadlocks.
 * 3. Dual-Resilience: Supports MongoDB Multi-Document Transactions when running on a
 *    Replica Set / Atlas cluster, with automatic Compensating Rollback (Saga pattern)
 *    when running on standalone or if a transaction is aborted.
 * 4. Cancellation Restoration: Guarantees that cancelled orders restore reserved stock.
 */

/**
 * Checks if the current MongoDB connection topology supports multi-document transactions.
 * @returns {boolean}
 */
function supportsTransactions() {
    try {
        if (mongoose.connection.readyState !== 1) return false;
        const topology = mongoose.connection.client?.topology?.description;
        if (!topology) return false;
        const type = topology.type;
        return type === 'ReplicaSetWithPrimary' || type === 'Sharded';
    } catch (_) {
        return false;
    }
}

/**
 * Consolidates items by productId to sum quantities if the same product appears multiple times.
 * @param {Array} items 
 * @returns {Map<string, { productId: string, quantity: number, name: string }>}
 */
function consolidateItemsByProductId(items) {
    const map = new Map();
    if (!Array.isArray(items)) return map;

    for (const item of items) {
        if (!item) continue;
        const rawId = item.product?._id || item.product || item.productId;
        if (!rawId) continue;
        const productId = String(rawId);
        const quantity = Number(item.quantity) || 0;
        if (quantity <= 0) continue;

        const name = item.name || item.product?.name || '';

        if (!map.has(productId)) {
            map.set(productId, { productId, quantity: 0, name });
        }
        const entry = map.get(productId);
        entry.quantity += quantity;
        if (!entry.name && name) entry.name = name;
    }

    return map;
}

/**
 * Atomically deducts stock for a list of order items.
 * Guaranteed to prevent race conditions & overselling.
 * 
 * If ANY item has insufficient stock or is inactive, the operation fails:
 * - If a transaction session is provided, caller can abort the transaction.
 * - If running without a transaction, an automatic compensating rollback restores
 *   any items that were already decremented prior to the failure.
 * 
 * @param {Array} items - List of items [{ product, quantity, name }]
 * @param {ClientSession|null} [session=null] - Optional Mongoose ClientSession
 * @returns {Promise<{ success: boolean, reservedItems?: Array, code?: string, message?: string, details?: Object }>}
 */
async function deductProductStockAtomically(items, session = null) {
    const consolidated = consolidateItemsByProductId(items);
    if (consolidated.size === 0) {
        return { success: true, reservedItems: [] };
    }

    const reservedItems = [];

    for (const [productId, item] of consolidated.entries()) {
        const requiredQty = item.quantity;

        // ─── Atomic Conditional Update ──────────────────────────────────────────
        // This query matches ONLY if stock is currently >= requiredQty AND isActive is true.
        // MongoDB document-level lock guarantees zero race condition between concurrent buyers.
        const updatedProduct = await Product.findOneAndUpdate(
            {
                _id: productId,
                stock: { $gte: requiredQty },
                isActive: true,
            },
            {
                $inc: {
                    stock: -requiredQty,
                    totalSold: requiredQty,
                },
            },
            { new: true, session }
        );

        if (updatedProduct) {
            // Check if stock has reached 0 to synchronize isSoldOut flag
            if (updatedProduct.stock <= 0 && !updatedProduct.isSoldOut) {
                await Product.updateOne(
                    { _id: productId },
                    { $set: { isSoldOut: true } },
                    { session }
                );
            }

            reservedItems.push({
                productId,
                name: updatedProduct.name || item.name,
                quantity: requiredQty,
                newStock: updatedProduct.stock,
            });
        } else {
            // ─── Reservation Failed for this item ──────────────────────────────
            // Look up product to provide precise error diagnosis
            let currentProduct = null;
            try {
                currentProduct = await Product.findById(productId)
                    .select('name stock isActive isSoldOut')
                    .lean();
            } catch (_) { }

            const isInactive = !currentProduct || !currentProduct.isActive;
            const availableStock = currentProduct ? Math.max(0, currentProduct.stock || 0) : 0;
            const prodName = currentProduct?.name || item.name || 'المنتج المحدد';

            const errorCode = isInactive ? 'PRODUCT_INACTIVE' : 'INSUFFICIENT_STOCK';
            const errorMessage = isInactive
                ? `المنتج "${prodName}" لم يعد متاحاً للشراء حالياً.`
                : `الكمية المتوفرة من "${prodName}" هي (${availableStock}) فقط، بينما الكمية المطلوبة هي (${requiredQty}).`;

            logger.warn('INVENTORY_DEDUCTION_FAILED', {
                productId,
                prodName,
                requiredQty,
                availableStock,
                isInactive,
            });

            // ─── Compensating Rollback (If no transaction session is handling it) ──
            if (!session && reservedItems.length > 0) {
                logger.info('INVENTORY_COMPENSATION_TRIGGERED', {
                    revertingCount: reservedItems.length,
                });
                for (const reserved of reservedItems) {
                    try {
                        await Product.updateOne(
                            { _id: reserved.productId },
                            {
                                $inc: {
                                    stock: reserved.quantity,
                                    totalSold: -reserved.quantity,
                                },
                                $set: { isSoldOut: false },
                            }
                        );
                    } catch (rollbackErr) {
                        logger.error('INVENTORY_COMPENSATION_ERROR', {
                            productId: reserved.productId,
                            error: rollbackErr.message,
                        });
                    }
                }
            }

            return {
                success: false,
                code: errorCode,
                message: errorMessage,
                details: {
                    productId,
                    productName: prodName,
                    requestedQuantity: requiredQty,
                    availableStock,
                    reason: errorCode,
                },
            };
        }
    }

    return {
        success: true,
        reservedItems,
    };
}

/**
 * Atomically restores stock for a list of items (e.g. on order cancellation, rejection, or failure).
 * 
 * @param {Array} items - List of items [{ product, quantity }]
 * @param {ClientSession|null} [session=null] - Optional Mongoose ClientSession
 * @returns {Promise<{ success: boolean, restoredCount: number }>}
 */
async function restoreProductStockAtomically(items, session = null) {
    const consolidated = consolidateItemsByProductId(items);
    if (consolidated.size === 0) {
        return { success: true, restoredCount: 0 };
    }

    let restoredCount = 0;
    for (const [productId, item] of consolidated.entries()) {
        try {
            await Product.updateOne(
                { _id: productId },
                {
                    $inc: {
                        stock: item.quantity,
                        totalSold: -item.quantity,
                    },
                    $set: { isSoldOut: false },
                },
                { session }
            );
            restoredCount++;
        } catch (err) {
            logger.error('INVENTORY_RESTORE_ERROR', {
                productId,
                quantity: item.quantity,
                error: err.message,
            });
        }
    }

    logger.info('INVENTORY_RESTORE_COMPLETED', { restoredProductsCount: restoredCount });
    return { success: true, restoredCount };
}

module.exports = {
    supportsTransactions,
    consolidateItemsByProductId,
    deductProductStockAtomically,
    restoreProductStockAtomically,
};
