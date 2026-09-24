/**
 * test_inventory_race_condition.js
 * 
 * Comprehensive test suite verifying:
 * 1. Race condition immunity: 10 concurrent requests for 1 remaining item.
 * 2. Multi-item cart atomicity & compensating rollback (Saga pattern).
 * 3. Same-product quantity consolidation within single order.
 * 4. Automatic stock restoration on order cancellation & return.
 * 5. Controller exports & syntax validation.
 */

const assert = require('assert');
const mongoose = require('mongoose');
const {
    consolidateItemsByProductId,
    deductProductStockAtomically,
    restoreProductStockAtomically,
} = require('../services/inventoryService');
const Product = mongoose.models.Product || require('../middlewares/Product').Product;

async function runTests() {
    console.log('================================================================');
    console.log('🧪 STARTING INVENTORY RACE CONDITION & ATOMICITY TEST SUITE');
    console.log('================================================================\n');

    // ─── TEST 1: Quantity Consolidation ──────────────────────────────────────
    console.log('🔹 TEST 1: Cart item quantity consolidation by productId...');
    const cartItems = [
        { product: '665f1a2b3c4d5e6f7a8b9001', quantity: 2, name: 'سماعات بلوتوث' },
        { product: '665f1a2b3c4d5e6f7a8b9002', quantity: 1, name: 'شاحن سريع' },
        { product: '665f1a2b3c4d5e6f7a8b9001', quantity: 3, name: 'سماعات بلوتوث (موقع تسليم مختلف)' },
    ];

    const consolidated = consolidateItemsByProductId(cartItems);
    assert.strictEqual(consolidated.size, 2, 'Should consolidate to exactly 2 distinct products');
    assert.strictEqual(consolidated.get('665f1a2b3c4d5e6f7a8b9001').quantity, 5, 'Quantity for prod 1 should be 2 + 3 = 5');
    assert.strictEqual(consolidated.get('665f1a2b3c4d5e6f7a8b9002').quantity, 1, 'Quantity for prod 2 should be 1');
    console.log('✅ TEST 1 PASSED: Quantities consolidated accurately.\n');

    // ─── TEST 2: Controller & Service Module Integrity ──────────────────────
    console.log('🔹 TEST 2: Validating Controllers and Services module exports...');
    const storeController = require('../Controllers/storeOrderController');
    const productController = require('../Controllers/productController');

    assert(typeof storeController.checkout === 'function', 'checkout must be a function');
    assert(typeof storeController.cancelOrder === 'function', 'cancelOrder must be a function');
    assert(typeof storeController.cancelOrderGroup === 'function', 'cancelOrderGroup must be a function');
    assert(typeof storeController.updateOrderStatus === 'function', 'updateOrderStatus must be a function');
    assert(typeof productController.updateStock === 'function', 'updateStock must be a function');
    console.log('✅ TEST 2 PASSED: All controllers and inventory handlers exported correctly.\n');

    // ─── TEST 3: Simulated Atomic Concurrent Race Condition ─────────────────
    console.log('🔹 TEST 3: High-concurrency Race Condition simulation (10 concurrent buyers for 1 item)...');

    // Simulated Product in-memory document with MongoDB atomic document-level locking semantics
    class SimulatedMongoDbEngine {
        constructor() {
            this.products = new Map();
            // Single lock per document matching MongoDB's document-level concurrency model
            this.locks = new Map();
        }

        setProduct(id, doc) {
            this.products.set(String(id), { ...doc });
        }

        async findOneAndUpdate(filter, update, options = {}) {
            const id = String(filter._id);
            // Simulate network latency (5ms - 20ms)
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 15) + 5));

            // Wait for document lock
            while (this.locks.get(id)) {
                await new Promise(r => setTimeout(r, 2));
            }
            this.locks.set(id, true);

            try {
                const doc = this.products.get(id);
                if (!doc) return null;

                // Check condition: stock >= filter.stock.$gte && isActive === true
                if (filter.isActive !== undefined && doc.isActive !== filter.isActive) return null;
                if (filter.stock && filter.stock.$gte !== undefined && doc.stock < filter.stock.$gte) return null;

                // Apply atomic update: $inc
                if (update.$inc) {
                    if (update.$inc.stock) doc.stock += update.$inc.stock;
                    if (update.$inc.totalSold) doc.totalSold = (doc.totalSold || 0) + update.$inc.totalSold;
                }
                if (update.$set) {
                    Object.assign(doc, update.$set);
                }
                if (doc.stock <= 0) doc.isSoldOut = true;

                this.products.set(id, { ...doc });
                return { ...doc };
            } finally {
                this.locks.delete(id);
            }
        }

        async updateOne(filter, update) {
            const id = String(filter._id);
            while (this.locks.get(id)) {
                await new Promise(r => setTimeout(r, 2));
            }
            this.locks.set(id, true);
            try {
                const doc = this.products.get(id);
                if (!doc) return;
                if (update.$inc) {
                    if (update.$inc.stock) doc.stock += update.$inc.stock;
                    if (update.$inc.totalSold) doc.totalSold = (doc.totalSold || 0) + update.$inc.totalSold;
                }
                if (update.$set) {
                    Object.assign(doc, update.$set);
                }
                this.products.set(id, { ...doc });
            } finally {
                this.locks.delete(id);
            }
        }

        async findById(id) {
            return this.products.get(String(id)) || null;
        }
    }

    const mockDb = new SimulatedMongoDbEngine();
    const testProductId = '665f1a2b3c4d5e6f7a8b9099';
    mockDb.setProduct(testProductId, {
        _id: testProductId,
        name: 'iPhone 15 Pro Max',
        stock: 1, // Only 1 piece available!
        totalSold: 0,
        isSoldOut: false,
        isActive: true,
    });

    // Temporarily point Product methods to mockDb to simulate exact concurrent execution
    const origFindOneAndUpdate = Product.findOneAndUpdate;
    const origUpdateOne = Product.updateOne;
    const origFindById = Product.findById;

    Product.findOneAndUpdate = (f, u, o) => mockDb.findOneAndUpdate(f, u, o);
    Product.updateOne = (f, u, o) => mockDb.updateOne(f, u, o);
    Product.findById = (id) => ({
        select: () => ({
            lean: async () => mockDb.findById(id),
        }),
    });

    try {
        // Fire 10 simultaneous orders at the exact same millisecond
        const concurrentBuyers = Array.from({ length: 10 }, (_, i) => ({
            buyerId: `Buyer_${i + 1}`,
            items: [{ product: testProductId, quantity: 1, name: 'iPhone 15 Pro Max' }],
        }));

        console.log('   🚀 Firing 10 concurrent requests simultaneously...');
        const results = await Promise.all(
            concurrentBuyers.map(b => deductProductStockAtomically(b.items))
        );

        const successes = results.filter(r => r.success);
        const failures = results.filter(r => !r.success);

        console.log(`   📊 Results: ${successes.length} Succeeded, ${failures.length} Rejected.`);

        assert.strictEqual(successes.length, 1, 'EXACTLY ONE request must succeed when stock is 1');
        assert.strictEqual(failures.length, 9, 'EXACTLY NINE requests must fail when stock is 1');

        failures.forEach((f, idx) => {
            assert.strictEqual(f.code, 'INSUFFICIENT_STOCK', `Failure #${idx + 1} must have code INSUFFICIENT_STOCK`);
            assert(f.message.includes('الكمية المتوفرة'), `Failure #${idx + 1} must have descriptive message`);
        });

        const finalProductState = await mockDb.findById(testProductId);
        assert.strictEqual(finalProductState.stock, 0, 'Final stock must be exactly 0 (no negative stock)');
        assert.strictEqual(finalProductState.totalSold, 1, 'Final totalSold must be exactly 1');
        assert.strictEqual(finalProductState.isSoldOut, true, 'isSoldOut must be true');

        console.log('✅ TEST 3 PASSED: Zero race condition! Exactly 1 sold, 9 rejected, stock = 0, no overselling!\n');

        // ─── TEST 4: Multi-item Cart Compensating Rollback (Saga) ───────────────
        console.log('🔹 TEST 4: Multi-item cart partial failure with Compensating Rollback...');
        const prodA = '665f1a2b3c4d5e6f7a8b90aa';
        const prodB = '665f1a2b3c4d5e6f7a8b90bb';

        mockDb.setProduct(prodA, { _id: prodA, name: 'حذاء رياضي', stock: 5, totalSold: 0, isActive: true });
        mockDb.setProduct(prodB, { _id: prodB, name: 'سترة شتوية', stock: 0, totalSold: 0, isActive: true, isSoldOut: true });

        const multiCart = [
            { product: prodA, quantity: 2, name: 'حذاء رياضي' },
            { product: prodB, quantity: 1, name: 'سترة شتوية' }, // This will fail!
        ];

        const multiResult = await deductProductStockAtomically(multiCart);
        assert.strictEqual(multiResult.success, false, 'Multi-item deduction must fail if any item is out of stock');
        assert.strictEqual(multiResult.code, 'INSUFFICIENT_STOCK');

        // Check if ProdA was rolled back from 3 back to 5
        const stateProdA = await mockDb.findById(prodA);
        assert.strictEqual(stateProdA.stock, 5, 'ProdA stock must be restored to 5 via Compensating Rollback');
        assert.strictEqual(stateProdA.totalSold, 0, 'ProdA totalSold must be restored to 0');
        console.log('✅ TEST 4 PASSED: Compensating Rollback successfully restored previous items with zero stock leakage!\n');

        // ─── TEST 5: Stock Restoration on Order Cancellation ──────────────────
        console.log('🔹 TEST 5: Order cancellation stock restoration...');
        const prodC = '665f1a2b3c4d5e6f7a8b90cc';
        mockDb.setProduct(prodC, { _id: prodC, name: 'ساعة يد', stock: 10, totalSold: 0, isActive: true });

        // 1. Client orders 3 items
        const buyResult = await deductProductStockAtomically([{ product: prodC, quantity: 3, name: 'ساعة يد' }]);
        assert.strictEqual(buyResult.success, true);
        let currentC = await mockDb.findById(prodC);
        assert.strictEqual(currentC.stock, 7, 'Stock after buying should be 7');
        assert.strictEqual(currentC.totalSold, 3, 'totalSold after buying should be 3');

        // 2. Client or Admin cancels order
        const cancelResult = await restoreProductStockAtomically([{ product: prodC, quantity: 3 }]);
        assert.strictEqual(cancelResult.success, true);
        currentC = await mockDb.findById(prodC);
        assert.strictEqual(currentC.stock, 10, 'Stock after cancellation should be restored to 10');
        assert.strictEqual(currentC.totalSold, 0, 'totalSold after cancellation should be restored to 0');
        assert.strictEqual(currentC.isSoldOut, false, 'isSoldOut should be false after restoration');
        console.log('✅ TEST 5 PASSED: Order cancellation correctly restored stock and reset isSoldOut.\n');

    } finally {
        // Restore original functions
        Product.findOneAndUpdate = origFindOneAndUpdate;
        Product.updateOne = origUpdateOne;
        Product.findById = origFindById;
    }

    console.log('================================================================');
    console.log('🎉 ALL 5 TESTS PASSED SUCCESSFULLY! ARCHITECTURE FULLY VERIFIED.');
    console.log('================================================================');
}

runTests().catch(err => {
    console.error('❌ Test suite failed:', err);
    process.exit(1);
});
