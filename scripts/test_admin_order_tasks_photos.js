process.env.TEST_MODE = 'true';
const mongoose = require('mongoose');
const { enrichOrder } = require('../Controllers/storeOrderController');
const { formatStoreOrderForRep } = require('../Controllers/orderController');

async function runTests() {
    console.log('========================================================================');
    console.log('🧪 TESTING ADMIN & REP BUSINESS ORDER TASKS PHOTO RESOLUTION (4 PHOTOS)');
    console.log('========================================================================\n');

    const mockReq = {
        protocol: 'https',
        get: () => 'mashawerr-np6n.onrender.com',
        user: { id: 'admin123', isAdmin: true, userType: 'Admin' }
    };

    // ────────────────────────────────────────────────────────────────────────
    // TEST CASE 1: Single Business Order with 2 Products (Same merchant)
    // ────────────────────────────────────────────────────────────────────────
    console.log('--- TEST 1: Single StoreOrder with 2 Distinct Products ---');

    const prod1Id = new mongoose.Types.ObjectId();
    const prod2Id = new mongoose.Types.ObjectId();

    const mockOrder2Products = {
        _id: new mongoose.Types.ObjectId(),
        storeOrderId: 1001,
        orderId: 1001,
        isBusinessOrder: true,
        orderCategory: 'business',
        status: 'delivered',
        userId: '507f1f77bcf86cd799439011',
        userInfo: { firstName: 'علي', lastName: 'محمد', phone: '90008000' },
        pickupPhoto: 'mashawerr/order-photos/pickup_root_fallback.jpg',
        deliveryPhoto: 'mashawerr/order-photos/delivery_root_fallback.jpg',
        items: [
            {
                product: prod1Id,
                name: 'قميص قطني أزرق',
                price: 10.0,
                quantity: 1,
                subtotal: 10.0,
                pickupPhoto: 'mashawerr/order-photos/pickup_shirt.jpg',
                deliveryPhoto: 'mashawerr/order-photos/delivery_shirt.jpg',
            },
            {
                product: prod2Id,
                name: 'حذاء رياضي أسود',
                price: 25.0,
                quantity: 1,
                subtotal: 25.0,
                pickupPhoto: 'mashawerr/order-photos/pickup_shoes.jpg',
                deliveryPhoto: 'mashawerr/order-photos/delivery_shoes.jpg',
            }
        ]
    };

    // 1. Test via storeOrderController.enrichOrder
    const enrichedStoreOrder = await enrichOrder(mockReq, mockOrder2Products);

    console.log('1.1 Checking storeOrderController.enrichOrder:');
    console.log('   Tasks count:', enrichedStoreOrder.tasks?.length);
    console.log('   Task 1 Pickup:', enrichedStoreOrder.tasks?.[0]?.itemPhotoBefore);
    console.log('   Task 1 Delivery:', enrichedStoreOrder.tasks?.[0]?.itemPhotoAfter);
    console.log('   Task 2 Pickup:', enrichedStoreOrder.tasks?.[1]?.itemPhotoBefore);
    console.log('   Task 2 Delivery:', enrichedStoreOrder.tasks?.[1]?.itemPhotoAfter);

    if (enrichedStoreOrder.tasks?.length !== 2) {
        throw new Error(`Expected 2 tasks in enrichOrder, got ${enrichedStoreOrder.tasks?.length}`);
    }
    if (!enrichedStoreOrder.tasks[0].itemPhotoBefore.includes('pickup_shirt.jpg') ||
        !enrichedStoreOrder.tasks[0].itemPhotoAfter.includes('delivery_shirt.jpg') ||
        !enrichedStoreOrder.tasks[1].itemPhotoBefore.includes('pickup_shoes.jpg') ||
        !enrichedStoreOrder.tasks[1].itemPhotoAfter.includes('delivery_shoes.jpg')) {
        throw new Error('Task photos in enrichOrder do not match the respective products!');
    }
    console.log('   ✅ enrichOrder generated 2 distinct tasks with 4 distinct photos!');

    // 2. Test via orderController (formatStoreOrderForRep)
    console.log('\n1.2 Checking orderController.formatStoreOrderForRep (used in listOrdersByUserId / Rep):');
    const formattedForRep = formatStoreOrderForRep(mockReq, mockOrder2Products, { businessRepCommissionPct: 100 });

    console.log('   Tasks count:', formattedForRep.tasks?.length);
    console.log('   Task 1 Pickup:', formattedForRep.tasks?.[0]?.itemPhotoBefore);
    console.log('   Task 1 Delivery:', formattedForRep.tasks?.[0]?.itemPhotoAfter);
    console.log('   Task 2 Pickup:', formattedForRep.tasks?.[1]?.itemPhotoBefore);
    console.log('   Task 2 Delivery:', formattedForRep.tasks?.[1]?.itemPhotoAfter);

    if (formattedForRep.tasks?.length !== 2) {
        throw new Error(`Expected 2 tasks in formatStoreOrderForRep, got ${formattedForRep.tasks?.length}`);
    }
    if (!formattedForRep.tasks[0].itemPhotoBefore.includes('pickup_shirt.jpg') ||
        !formattedForRep.tasks[0].itemPhotoAfter.includes('delivery_shirt.jpg') ||
        !formattedForRep.tasks[1].itemPhotoBefore.includes('pickup_shoes.jpg') ||
        !formattedForRep.tasks[1].itemPhotoAfter.includes('delivery_shoes.jpg')) {
        throw new Error('Task photos in formatStoreOrderForRep do not match the respective products!');
    }
    console.log('   ✅ formatStoreOrderForRep generated 2 distinct tasks with 4 distinct photos!');

    // ────────────────────────────────────────────────────────────────────────
    // TEST CASE 2: Business Order with 2 Sub-Orders (Multi-merchant group)
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 2: Multi-SubOrder Business Order (Split group) ---');

    const mockGroupOrder = {
        _id: new mongoose.Types.ObjectId(),
        parentGroupId: 'group-uuid-444',
        storeOrderId: 1002,
        isBusinessOrder: true,
        orderCategory: 'business',
        status: 'delivered',
        userId: '507f1f77bcf86cd799439011',
        userInfo: { firstName: 'علي', lastName: 'محمد', phone: '90008000' },
        subOrders: [
            {
                _id: new mongoose.Types.ObjectId(),
                storeOrderId: 1002,
                status: 'delivered',
                pickupPhoto: 'mashawerr/order-photos/pickup_sub1.jpg',
                deliveryPhoto: 'mashawerr/order-photos/delivery_sub1.jpg',
                items: [
                    {
                        name: 'عسل سدر طبيعي',
                        price: 15.0,
                        quantity: 1,
                        pickupPhoto: 'mashawerr/order-photos/pickup_sub1.jpg',
                        deliveryPhoto: 'mashawerr/order-photos/delivery_sub1.jpg',
                    }
                ]
            },
            {
                _id: new mongoose.Types.ObjectId(),
                storeOrderId: 1003,
                status: 'delivered',
                pickupPhoto: 'mashawerr/order-photos/pickup_sub2.jpg',
                deliveryPhoto: 'mashawerr/order-photos/delivery_sub2.jpg',
                items: [
                    {
                        name: 'زيت زيتون بكر',
                        price: 8.0,
                        quantity: 2,
                        pickupPhoto: 'mashawerr/order-photos/pickup_sub2.jpg',
                        deliveryPhoto: 'mashawerr/order-photos/delivery_sub2.jpg',
                    }
                ]
            }
        ]
    };

    const enrichedGroup = await enrichOrder(mockReq, mockGroupOrder);
    console.log('   Group Tasks count:', enrichedGroup.tasks?.length);
    console.log('   Group Task 1 Pickup:', enrichedGroup.tasks?.[0]?.itemPhotoBefore);
    console.log('   Group Task 1 Delivery:', enrichedGroup.tasks?.[0]?.itemPhotoAfter);
    console.log('   Group Task 2 Pickup:', enrichedGroup.tasks?.[1]?.itemPhotoBefore);
    console.log('   Group Task 2 Delivery:', enrichedGroup.tasks?.[1]?.itemPhotoAfter);

    if (enrichedGroup.tasks?.length !== 2) {
        throw new Error(`Expected 2 tasks in multi-subOrder, got ${enrichedGroup.tasks?.length}`);
    }
    if (!enrichedGroup.tasks[0].itemPhotoBefore.includes('pickup_sub1.jpg') ||
        !enrichedGroup.tasks[0].itemPhotoAfter.includes('delivery_sub1.jpg') ||
        !enrichedGroup.tasks[1].itemPhotoBefore.includes('pickup_sub2.jpg') ||
        !enrichedGroup.tasks[1].itemPhotoAfter.includes('delivery_sub2.jpg')) {
        throw new Error('SubOrder task photos do not match!');
    }
    console.log('   ✅ Multi-subOrder generated 2 distinct tasks with 4 distinct photos!');

    // ────────────────────────────────────────────────────────────────────────
    // TEST CASE 3: Flutter Admin Proof Photos Widget Extraction Simulation
    // ────────────────────────────────────────────────────────────────────────
    console.log('\n--- TEST 3: Simulating Flutter Admin Proof Photos Extraction ---');

    function simulateFlutterProofPhotos(order) {
        const pickupUrls = [];
        const deliveryUrls = [];

        function addPickup(url) {
            if (url && !pickupUrls.includes(url)) pickupUrls.push(url);
        }
        function addDelivery(url) {
            if (url && !deliveryUrls.includes(url)) deliveryUrls.push(url);
        }

        // 1. Root
        addPickup(order.pickupPhoto || order.pickupPhotoUrl || order.itemPhotoBefore);
        addDelivery(order.deliveryPhoto || order.deliveryPhotoUrl || order.itemPhotoAfter);

        // 2. Tasks
        const rawTasks = order.tasks || order.orderTasks || [];
        rawTasks.forEach(t => {
            addPickup(t.itemPhotoBefore || t.pickupPhoto || t.pickupPhotoUrl);
            addDelivery(t.itemPhotoAfter || t.deliveryPhoto || t.deliveryPhotoUrl);
        });

        // 3. SubOrders
        const rawSubOrders = order.subOrders || [];
        rawSubOrders.forEach(s => {
            addPickup(s.pickupPhoto || s.pickupPhotoUrl || s.itemPhotoBefore);
            addDelivery(s.deliveryPhoto || s.deliveryPhotoUrl || s.itemPhotoAfter);
        });

        return {
            totalPickups: pickupUrls.length,
            totalDeliveries: deliveryUrls.length,
            totalPhotos: pickupUrls.length + deliveryUrls.length,
            pickupUrls,
            deliveryUrls
        };
    }

    const flutterExtraction = simulateFlutterProofPhotos(enrichedStoreOrder);
    console.log('   Flutter Extracted Total Pickups:', flutterExtraction.totalPickups);
    console.log('   Flutter Extracted Total Deliveries:', flutterExtraction.totalDeliveries);
    console.log('   Flutter Extracted Total Photos (Expected 4):', flutterExtraction.totalPhotos);

    if (flutterExtraction.totalPhotos < 4) {
        throw new Error(`Flutter extraction produced ${flutterExtraction.totalPhotos} photos, expected 4 photos!`);
    }

    console.log('   ✅ Flutter Admin will now display all 4 photos for the 2 products!');
    console.log('\n========================================================================');
    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY WITH 100% ACCURACY!');
    console.log('========================================================================');
    process.exit(0);
}

runTests().catch(err => {
    console.error('\n❌ TEST FAILED:', err.message);
    process.exit(1);
});
