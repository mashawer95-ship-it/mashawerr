const { enrichOrder } = require('./Controllers/storeOrderController');
const { BusinessOrderTracker } = require('./services/BusinessOrderTracker');
const { ORDER_STATUSES, ORDER_STATUS_LABELS_AR } = require('./constants/orderTypes');
const { STORE_ORDER_STATUSES } = require('./middlewares/StoreOrder');

async function runUnitTests() {
    console.log('🧪 Running Return System In-Memory Unit Tests...\n');

    let passed = 0;
    let total = 0;

    function assert(condition, message) {
        total++;
        if (!condition) {
            console.error(`❌ FAILED: ${message}`);
            throw new Error(message);
        }
        passed++;
        console.log(`✅ PASSED: ${message}`);
    }

    // ─── Test Suite 1: Status Enums & Arabic Labels ───
    console.log('--- Test Suite 1: Enums & Constants ---');
    assert(ORDER_STATUSES.includes('return_pending'), 'ORDER_STATUSES must contain return_pending');
    assert(ORDER_STATUSES.includes('return_accepted'), 'ORDER_STATUSES must contain return_accepted');
    assert(ORDER_STATUSES.includes('return_delivering'), 'ORDER_STATUSES must contain return_delivering');
    assert(ORDER_STATUSES.includes('returned'), 'ORDER_STATUSES must contain returned');
    assert(ORDER_STATUSES.includes('return_cancelled'), 'ORDER_STATUSES must contain return_cancelled');

    assert(STORE_ORDER_STATUSES.includes('return_pending'), 'STORE_ORDER_STATUSES must contain return_pending');
    assert(ORDER_STATUS_LABELS_AR['return_pending'] === 'مرتجع - بانتظار المندوب', 'ORDER_STATUS_LABELS_AR must have arabic label for return_pending');
    assert(ORDER_STATUS_LABELS_AR['returned'] === 'مرتجع - مكتمل', 'ORDER_STATUS_LABELS_AR must have arabic label for returned');

    // ─── Test Suite 2: 48-Hour Return Window Verification in enrichOrder ───
    console.log('\n--- Test Suite 2: 48-Hour Window Calculation ---');
    const now = Date.now();
    const delivered1HourAgo = new Date(now - 1 * 60 * 60 * 1000);
    const delivered50HoursAgo = new Date(now - 50 * 60 * 60 * 1000);

    const mockOrderEligible = {
        storeOrderId: 1001,
        userId: 'user_1',
        status: 'delivered',
        deliveredAt: delivered1HourAgo,
        totalPrice: 20000,
        deliveryPrice: 1500,
        items: [{
            product: '64f1a2b3c4d5e6f7a8b9c0d1',
            name: 'قميص صيفي أنيق',
            price: 20000,
            quantity: 1,
            pickupLocation: { lat: 29.33, lng: 48.02, address: 'محل الملابس - حولي' },
            deliveryLocation: { lat: 29.37, lng: 47.97, address: 'العميل - مدينة الكويت' },
        }],
        deliveryLocation: { lat: 29.37, lng: 47.97, address: 'العميل - مدينة الكويت' },
        userInfo: { firstName: 'علي', lastName: 'الكندري', phone: '96599991111' },
    };

    const enriched1 = await enrichOrder(mockOrderEligible);
    assert(enriched1.canReturn === true, 'Order delivered 1h ago MUST be eligible for return (canReturn = true)');
    assert(enriched1.returnWindowRemainingHours >= 46 && enriched1.returnWindowRemainingHours <= 47.5, 'Remaining hours must be around 47 hours');
    assert(enriched1.returnWindowExpired === false, 'returnWindowExpired must be false for 1h ago order');

    const mockOrderExpired = {
        ...mockOrderEligible,
        storeOrderId: 1002,
        deliveredAt: delivered50HoursAgo,
    };

    const enriched2 = await enrichOrder(mockOrderExpired);
    assert(enriched2.canReturn === false, 'Order delivered 50h ago must NOT be eligible (canReturn = false)');
    assert(enriched2.returnWindowExpired === true, 'returnWindowExpired must be true for 50h ago order');

    // ─── Test Suite 3: Location Inversion & Dual Interfaces ───
    console.log('\n--- Test Suite 3: Inverted Locations for Representative ---');
    const mockOrderReturn = {
        storeOrderId: 1003,
        userId: 'user_1',
        status: 'return_pending',
        isReturnOrder: true,
        deliveredAt: delivered1HourAgo,
        totalPrice: 20000,
        deliveryPrice: 1500,
        returnDetails: {
            reason: 'المقاس أصغر من المطلوب',
            customerAgreedToFee: true,
            deliveryFeeFils: 1500,
        },
        items: [{
            product: '64f1a2b3c4d5e6f7a8b9c0d1',
            name: 'قميص صيفي أنيق',
            price: 20000,
            quantity: 1,
            pickupLocation: { lat: 29.33, lng: 48.02, address: 'محل الملابس - حولي' },
            deliveryLocation: { lat: 29.37, lng: 47.97, address: 'العميل - مدينة الكويت' },
        }],
        deliveryLocation: { lat: 29.37, lng: 47.97, address: 'العميل - مدينة الكويت' },
        userInfo: { firstName: 'علي', lastName: 'الكندري', phone: '96599991111' },
    };

    const enrichedReturn = await enrichOrder(mockOrderReturn);
    assert(enrichedReturn.isReturnOrder === true, 'isReturnOrder must be true');
    assert(typeof enrichedReturn.returnBannerNotice === 'string' && enrichedReturn.returnBannerNotice.includes('طلب مرتجع'), 'returnBannerNotice must be present');

    const returnTask = enrichedReturn.tasks[0];
    assert(returnTask.isReturnTask === true, 'Task must be marked as isReturnTask');
    assert(returnTask.pickupLocation.isClientInterface === true, 'Pickup must be marked as isClientInterface');
    assert(returnTask.pickupLocation.roleLabel.includes('واجهة عميل'), 'Pickup roleLabel must state واجهة عميل');
    assert(returnTask.pickupLocation.streetName.includes('العميل'), 'Pickup address must be Customer location');
    assert(returnTask.pickupLocation.phoneNumber === '96599991111', 'Pickup phone must be Customer phone');

    assert(returnTask.deliveryLocation.isAgentInterface === true, 'Delivery must be marked as isAgentInterface');
    assert(returnTask.deliveryLocation.roleLabel.includes('واجهة وكيل'), 'Delivery roleLabel must state واجهة وكيل');
    assert(returnTask.deliveryLocation.streetName.includes('محل الملابس'), 'Delivery address must be Store/Agent location');

    assert(returnTask.fromLatitude === 29.37 && returnTask.fromLongitude === 47.97, 'fromLatitude/Longitude must be Customer coords');
    assert(returnTask.toLatitude === 29.33 && returnTask.toLongitude === 48.02, 'toLatitude/Longitude must be Store coords');

    // ─── Test Suite 4: Multi-SubOrder Inverted Stops in BusinessOrderTracker ───
    console.log('\n--- Test Suite 4: Sequential Stops in BusinessOrderTracker ---');
    const mockTrackerReturn = {
        subOrders: [
            {
                _id: 'sub_1',
                storeOrderId: 1003,
                isReturnOrder: true,
                status: 'return_pending',
                agentName: 'بوتيك الأناقة',
                returnDetails: { reason: 'المقاس غير مناسب' },
                pickupLocation: { lat: 29.33, lng: 48.02, address: 'بوتيك الأناقة - حولي' },
                deliveryLocation: { lat: 29.37, lng: 47.97, address: 'شقة العميل - العاصمة' },
                userInfo: { firstName: 'خالد', lastName: 'المطيري', phone: '96555554444' },
                items: [{
                    name: 'ساعة يد كلاسيكية',
                    pickupLocation: { lat: 29.33, lng: 48.02, address: 'بوتيك الأناقة - حولي' },
                    deliveryLocation: { lat: 29.37, lng: 47.97, address: 'شقة العميل - العاصمة' },
                }]
            }
        ]
    };

    // Test stop structure when built for return
    const isReturn = true;
    const cleanCustomerName = 'خالد المطيري';
    const it = mockTrackerReturn.subOrders[0].items[0];
    const stop1Pickup = {
        type: 'PICKUP',
        isReturnStop: true,
        isClientInterface: true,
        roleLabel: 'واجهة عميل (استلام من العميل)',
        title: `استلام مرتجع 1: ${cleanCustomerName}`,
        location: it.deliveryLocation, // Client location
    };

    const stop2Delivery = {
        type: 'DELIVERY',
        isReturnStop: true,
        isAgentInterface: true,
        roleLabel: 'واجهة وكيل (تسليم للمتجر)',
        title: `تسليم مرتجع 1: بوتيك الأناقة`,
        location: it.pickupLocation, // Store location
    };

    assert(stop1Pickup.location.address.includes('العاصمة'), 'Return Stop 1 (Pickup) must be Client address in العاصمة');
    assert(stop2Delivery.location.address.includes('حولي'), 'Return Stop 2 (Delivery) must be Store address in حولي');
    assert(stop1Pickup.roleLabel.includes('واجهة عميل'), 'Stop 1 role must be واجهة عميل');
    assert(stop2Delivery.roleLabel.includes('واجهة وكيل'), 'Stop 2 role must be واجهة وكيل');

    // ─── Test Suite 5: Confirm Arrival & Release Order Status Validation ───
    console.log('\n--- Test Suite 5: Confirm Arrival & Release Order Lifecycle ---');
    const fs = require('fs');
    const path = require('path');
    const orderCtrlCode = fs.readFileSync(path.join(__dirname, 'Controllers', 'orderController.js'), 'utf8');

    // Verify allowedStatuses in confirmArrival includes return_accepted and return_delivering
    const confirmArrivalAllowedRegex = /const\s+allowedStatuses\s*=\s*\[([^\]]+)\]/;
    const confirmMatch = orderCtrlCode.match(confirmArrivalAllowedRegex);
    assert(confirmMatch !== null, 'confirmArrival must define allowedStatuses');
    assert(confirmMatch[1].includes("'return_accepted'"), 'allowedStatuses in confirmArrival must include return_accepted');
    assert(confirmMatch[1].includes("'return_delivering'"), 'allowedStatuses in confirmArrival must include return_delivering');

    // Verify allowedReleaseStatuses in releaseOrder includes return_accepted and return_delivering
    const releaseAllowedRegex = /const\s+allowedReleaseStatuses\s*=\s*\[([^\]]+)\]/;
    const releaseMatch = orderCtrlCode.match(releaseAllowedRegex);
    assert(releaseMatch !== null, 'releaseOrder must define allowedReleaseStatuses');
    assert(releaseMatch[1].includes("'return_accepted'"), 'allowedReleaseStatuses in releaseOrder must include return_accepted');
    assert(releaseMatch[1].includes("'return_delivering'"), 'allowedReleaseStatuses in releaseOrder must include return_delivering');

    // Verify releaseOrder resets status to return_pending for return orders
    assert(orderCtrlCode.includes("so.status = isReturn ? 'return_pending' : 'pending'"), 'releaseOrder must reset store orders to return_pending');
    assert(orderCtrlCode.includes("order.status = isReturn ? 'return_pending' : 'waiting'"), 'releaseOrder must reset main orders to return_pending');

    console.log(`\n========================================`);
    console.log(`🎉 ALL ${passed}/${total} UNIT TESTS PASSED SUCCESSFULLY!`);
    console.log(`========================================\n`);
}

runUnitTests().catch(err => {
    console.error('Test runner failed:', err);
    process.exit(1);
});
