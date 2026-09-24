const mongoose = require('mongoose');
const { StoreOrder } = require('../middlewares/StoreOrder');
const { enrichOrder, updateRepresentativeStoreOrderStatus, uploadStoreOrderPhoto } = require('../Controllers/storeOrderController');
const { formatStoreOrderForRep } = require('../Controllers/orderController');
const { enrichOrderData } = require('../Controllers/userController');

async function runTest() {
    console.log('=== Running Representative Multi-Stop Multi-Product Delivery Test ===');

    const fakeRepId = new mongoose.Types.ObjectId().toString();
    const fakeUserId = new mongoose.Types.ObjectId().toString();
    const prodId1 = new mongoose.Types.ObjectId();
    const prodId2 = new mongoose.Types.ObjectId();

    // 1. Create a StoreOrder with 2 distinct products and distinct locations
    const orderDoc = new StoreOrder({
        _id: new mongoose.Types.ObjectId(),
        storeOrderId: 99881,
        userId: fakeUserId,
        representativeId: fakeRepId,
        status: 'confirmed',
        totalPrice: 250,
        deliveryPrice: 30,
        items: [
            {
                product: prodId1,
                name: 'Product 1 (Burger)',
                price: 100,
                quantity: 1,
                subtotal: 100,
                status: 'confirmed',
                isPickedUp: false,
                isDelivered: false,
                pickupLocation: { lat: 26.55, lng: 31.65, address: 'Restaurant Alpha' },
                deliveryLocation: { lat: 26.56, lng: 31.66, address: 'Customer Home 1' },
            },
            {
                product: prodId2,
                name: 'Product 2 (Pizza)',
                price: 120,
                quantity: 1,
                subtotal: 120,
                status: 'confirmed',
                isPickedUp: false,
                isDelivered: false,
                pickupLocation: { lat: 26.57, lng: 31.67, address: 'Restaurant Beta' },
                deliveryLocation: { lat: 26.58, lng: 31.68, address: 'Customer Office 2' },
            }
        ],
        pickupLocation: { lat: 26.55, lng: 31.65, address: 'Restaurant Alpha' },
        deliveryLocation: { lat: 26.56, lng: 31.66, address: 'Customer Home 1' },
        createdAt: new Date(),
        updatedAt: new Date(),
    });

    console.log('\n[Step 1] Initial Enrichment:');
    let enriched = await enrichOrder(orderDoc);
    console.log('Order status:', enriched.status);
    console.log('Task 1 drop location:', enriched.tasks[0].toLatitude, enriched.tasks[0].toLongitude, enriched.tasks[0].deliveryLocation?.streetName);
    console.log('Task 2 drop location:', enriched.tasks[1].toLatitude, enriched.tasks[1].toLongitude, enriched.tasks[1].deliveryLocation?.streetName);

    if (enriched.tasks[0].toLatitude !== 26.56 || enriched.tasks[0].toLongitude !== 31.66) {
        throw new Error(`Task 1 delivery coordinates mismatch! Expected 26.56, 31.66 got ${enriched.tasks[0].toLatitude}, ${enriched.tasks[0].toLongitude}`);
    }
    if (enriched.tasks[1].toLatitude !== 26.58 || enriched.tasks[1].toLongitude !== 31.68) {
        throw new Error(`Task 2 delivery coordinates mismatch! Expected 26.58, 31.68 got ${enriched.tasks[1].toLatitude}, ${enriched.tasks[1].toLongitude}`);
    }
    if (enriched.tasks[0].isDelivered || enriched.tasks[1].isDelivered) {
        throw new Error('Tasks should not be delivered initially!');
    }

    // 2. Pickup Task 1
    console.log('\n[Step 2] Marking Task 1 as Picked Up (shipped)...');
    let req1 = {
        params: { id: orderDoc._id.toString() },
        body: { status: 'shipped', taskId: 1, itemIndex: 0 },
        user: { id: fakeRepId, isAdmin: false },
    };
    // Simulate DB mock for save
    orderDoc.save = async function() { return this; };
    StoreOrder.findById = async function(id) { return orderDoc; };
    StoreOrder.find = function(query) {
        const p = Promise.resolve([orderDoc]);
        p.lean = async () => [orderDoc];
        return p;
    };

    let resData = null;
    let resStatus = 200;
    const mockRes = {
        status: (code) => { resStatus = code; return mockRes; },
        json: (data) => { resData = data; return mockRes; }
    };

    await updateRepresentativeStoreOrderStatus(req1, mockRes);
    console.log('Update result status:', resStatus, 'Order status:', orderDoc.status);
    console.log('Item 1 isPickedUp:', orderDoc.items[0].isPickedUp, 'Item 2 isPickedUp:', orderDoc.items[1].isPickedUp);

    if (!orderDoc.items[0].isPickedUp) throw new Error('Item 1 should be picked up!');
    if (orderDoc.items[1].isPickedUp) throw new Error('Item 2 should NOT be picked up yet!');

    // 3. Pickup Task 2
    console.log('\n[Step 3] Marking Task 2 as Picked Up (shipped)...');
    let req2 = {
        params: { id: orderDoc._id.toString() },
        body: { status: 'shipped', taskId: 2, itemIndex: 1 },
        user: { id: fakeRepId, isAdmin: false },
    };
    await updateRepresentativeStoreOrderStatus(req2, mockRes);
    console.log('Item 1 isPickedUp:', orderDoc.items[0].isPickedUp, 'Item 2 isPickedUp:', orderDoc.items[1].isPickedUp);

    if (!orderDoc.items[1].isPickedUp) throw new Error('Item 2 should be picked up!');

    // 4. Deliver Task 1
    console.log('\n[Step 4] Delivering Task 1 (Stop 1)...');
    orderDoc.items[0].deliveryPhoto = '/uploads/proof1.jpg';
    let req3 = {
        params: { id: orderDoc._id.toString() },
        body: { status: 'delivered', taskId: 1, itemIndex: 0 },
        user: { id: fakeRepId, isAdmin: false },
    };
    await updateRepresentativeStoreOrderStatus(req3, mockRes);
    console.log('Order status after delivering Task 1:', orderDoc.status);
    console.log('Item 1 status:', orderDoc.items[0].status, 'isDelivered:', orderDoc.items[0].isDelivered);
    console.log('Item 2 status:', orderDoc.items[1].status, 'isDelivered:', orderDoc.items[1].isDelivered);

    if (orderDoc.status === 'delivered') {
        throw new Error('Order status MUST NOT be "delivered" after only 1 of 2 items is delivered!');
    }
    if (!orderDoc.items[0].isDelivered) throw new Error('Item 1 must be marked as isDelivered: true');
    if (orderDoc.items[1].isDelivered) throw new Error('Item 2 must NOT be marked as isDelivered!');

    // Check enriched tasks after delivering task 1
    enriched = await enrichOrder(orderDoc);
    console.log('Enriched Task 1 status:', enriched.tasks[0].taskStatus, 'isDelivered:', enriched.tasks[0].isDelivered);
    console.log('Enriched Task 2 status:', enriched.tasks[1].taskStatus, 'isDelivered:', enriched.tasks[1].isDelivered);

    if (!enriched.tasks[0].isDelivered || enriched.tasks[0].taskStatus !== 'completed') {
        throw new Error('Task 1 should be completed/delivered in enriched view!');
    }
    if (enriched.tasks[1].isDelivered || enriched.tasks[1].taskStatus === 'completed') {
        throw new Error('Task 2 should still be inprogress/undelivered in enriched view!');
    }

    // Check Rep format
    const reqMock = { protocol: 'https', get: () => 'api.mashawerr.com', headers: { host: 'api.mashawerr.com' } };
    const formattedRep = formatStoreOrderForRep(orderDoc, reqMock);
    console.log('Rep Formatted Task 1 isDelivered:', formattedRep.tasks[0].isDelivered);
    console.log('Rep Formatted Task 2 isDelivered:', formattedRep.tasks[1].isDelivered);

    if (!formattedRep.tasks[0].isDelivered || formattedRep.tasks[1].isDelivered) {
        throw new Error('Rep formatted tasks delivery status mismatch!');
    }

    // 5. Deliver Task 2
    console.log('\n[Step 5] Delivering Task 2 (Stop 2)...');
    orderDoc.items[1].deliveryPhoto = '/uploads/proof2.jpg';
    let req4 = {
        params: { id: orderDoc._id.toString() },
        body: { status: 'delivered', taskId: 2, itemIndex: 1 },
        user: { id: fakeRepId, isAdmin: false },
    };
    await updateRepresentativeStoreOrderStatus(req4, mockRes);
    console.log('Order status after delivering Task 2:', orderDoc.status);
    console.log('Item 1 isDelivered:', orderDoc.items[0].isDelivered);
    console.log('Item 2 isDelivered:', orderDoc.items[1].isDelivered);

    if (orderDoc.status !== 'delivered') {
        throw new Error('Order status MUST be "delivered" now that all items are delivered!');
    }

    enriched = await enrichOrder(orderDoc);
    console.log('Final Enriched Order status:', enriched.status);
    console.log('Final Task 1 isDelivered:', enriched.tasks[0].isDelivered);
    console.log('Final Task 2 isDelivered:', enriched.tasks[1].isDelivered);

    // 6. Test getOrderById on StoreOrder
    console.log('\n[Step 6] Testing getOrderById on StoreOrder (orderId: 99881)...');
    const { getOrderById } = require('../Controllers/orderController');
    const { Order } = require('../middlewares/Order');
    Order.findOne = async () => null; // Simulate not found in Order collection
    StoreOrder.findOne = async (query) => {
        if (query.storeOrderId === 99881 || query.orderId === 99881) return orderDoc;
        return null;
    };

    let fetchedOrderJson = null;
    const mockGetRes = {
        status: (code) => mockGetRes,
        json: (data) => { fetchedOrderJson = data; return mockGetRes; }
    };
    await getOrderById({ params: { id: '99881' }, user: { id: fakeRepId } }, mockGetRes);
    console.log('Fetched StoreOrder via /api/orders/:id tasks count:', fetchedOrderJson?.tasks?.length);
    console.log('Fetched StoreOrder status:', fetchedOrderJson?.status);
    if (!fetchedOrderJson || fetchedOrderJson.tasks.length !== 2) {
        throw new Error('getOrderById failed to return store order with 2 tasks!');
    }

    // 7. Test POD reviewAttempt on StoreOrder with 2 items
    console.log('\n[Step 7] Testing PoD reviewAttempt for Task 1 of StoreOrder...');
    const { reviewAttempt } = require('../Controllers/podController');
    const { DeliverySession } = require('../models/DeliverySession');
    const { DeliveryAttempt } = require('../models/DeliveryAttempt');

    const fakeSessionId = 'sess_' + Date.now();
    const fakeAttemptId = 'att_' + Date.now();

    const mockSession = {
        sessionId: fakeSessionId,
        orderId: orderDoc.storeOrderId,
        phase: 'DELIVERY',
        state: 'IN_PROGRESS',
        subState: 'WAITING_CUSTOMER_REVIEW',
        driverId: fakeRepId,
        customerId: fakeUserId,
        version: 1,
        save: async function() { return this; }
    };

    const mockAttempt = {
        attemptId: fakeAttemptId,
        sessionId: fakeSessionId,
        phase: 'DELIVERY',
        state: 'WAITING_CUSTOMER_REVIEW',
        taskId: '1',
        itemIndex: 0,
        save: async function() { return this; }
    };

    // Reset order items status for POD review test
    orderDoc.status = 'shipped';
    orderDoc.items[0].status = 'shipped';
    orderDoc.items[0].isDelivered = false;
    orderDoc.items[1].status = 'shipped';
    orderDoc.items[1].isDelivered = false;

    DeliverySession.findOne = async () => mockSession;
    DeliveryAttempt.findOne = async () => mockAttempt;

    let reviewResultJson = null;
    const mockReviewReq = {
        params: { sessionId: fakeSessionId, attemptId: fakeAttemptId },
        body: { decision: 'YES' },
        baseUrl: '/api/store/orders',
        app: { get: () => null },
        headers: {}
    };
    const mockReviewRes = {
        status: (code) => mockReviewRes,
        json: (data) => { reviewResultJson = data; return mockReviewRes; }
    };

    await reviewAttempt(mockReviewReq, mockReviewRes);
    console.log('PoD Review Task 1 result:', reviewResultJson);
    console.log('Order status after PoD review Task 1:', orderDoc.status);
    console.log('Item 1 isDelivered:', orderDoc.items[0].isDelivered, 'Item 2 isDelivered:', orderDoc.items[1].isDelivered);

    if (reviewResultJson.isCompleted === true) {
        throw new Error('PoD review for Task 1 MUST NOT set isCompleted: true when Task 2 is still pending!');
    }
    if (orderDoc.status === 'delivered') {
        throw new Error('Order status MUST NOT be delivered after reviewing only Task 1!');
    }
    if (!orderDoc.items[0].isDelivered || orderDoc.items[1].isDelivered) {
        throw new Error('Only Item 1 should be marked delivered after PoD Task 1 review!');
    }

    console.log('\n✅ ALL REPRESENTATIVE MULTI-STOP DELIVERY TESTS PASSED SUCCESSFULLY!');
}

runTest().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
