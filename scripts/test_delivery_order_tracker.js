const { DeliveryOrderTracker } = require('../services/DeliveryOrderTracker');

async function testDeliveryOrderTracker() {
    console.log('=== 🧪 Testing DeliveryOrderTracker with Sequence (Pickup 1 -> Delivery 1 -> Pickup 2 -> Delivery 2) ===\n');

    // Simulate customer order created via multi_destination_search_page.dart
    const mockOrder = {
        orderId: 1001,
        representativeId: 'rep_123',
        clientId: 'client_456',
        status: 'accepted',
        allLocationsInOrder: [
            {
                name: 'المطعم الأول',
                address: 'شارع المطاعم 1',
                lat: 26.55,
                lng: 31.65,
                isFrom: true,
                order: 0,
                isCompleted: false,
            },
            {
                name: 'منزل العميل 1',
                address: 'شارع الزهور 10',
                lat: 26.56,
                lng: 31.66,
                isFrom: false,
                order: 1,
                isCompleted: false,
            },
            {
                name: 'المتجر الثاني',
                address: 'شارع السوق 5',
                lat: 26.57,
                lng: 31.67,
                isFrom: true,
                order: 2,
                isCompleted: false,
            },
            {
                name: 'مكتب العميل 2',
                address: 'برج الأمل 3',
                lat: 26.58,
                lng: 31.68,
                isFrom: false,
                order: 3,
                isCompleted: false,
            },
        ],
    };

    // Stage 0: Initial State
    let track = await DeliveryOrderTracker.getOrderTrack(mockOrder);
    console.log('📍 [Stage 0] Initial State:');
    console.log('   Total stops:', track.totalStops);
    console.log('   Current stop index:', track.currentStopIndex);
    console.log('   Current stop title:', track.currentStop.title);
    console.log('   Phase:', track.phase);
    console.log('   All pickups done:', track.allPickupsDone);
    console.log('   Is all completed:', track.isAllCompleted);
    if (track.currentStopIndex !== 0 || track.phase !== 'PICKUP') {
        throw new Error('Stage 0 failed!');
    }

    // Stage 1: Representative completes Pickup 1 (Stop 0)
    mockOrder.allLocationsInOrder[0].isCompleted = true;
    mockOrder.status = 'delivering';
    mockOrder.tasks = [{ taskId: 'task_1', taskStatus: 'completed' }]; // Edge case: tasks has 1 task
    track = await DeliveryOrderTracker.getOrderTrack(mockOrder);
    console.log('\n📍 [Stage 1] After Pickup 1 Approved:');
    console.log('   Current stop index:', track.currentStopIndex);
    console.log('   Current stop title:', track.currentStop.title);
    console.log('   Phase:', track.phase);
    console.log('   All pickups done:', track.allPickupsDone);
    if (track.currentStopIndex !== 1 || track.phase !== 'DELIVERY' || track.currentStop.type !== 'DELIVERY') {
        throw new Error('Stage 1 failed! Expected currentStopIndex: 1, phase: DELIVERY');
    }

    // Stage 2: Representative completes Delivery 1 (Stop 1)
    mockOrder.allLocationsInOrder[1].isCompleted = true;
    track = await DeliveryOrderTracker.getOrderTrack(mockOrder);
    console.log('\n📍 [Stage 2] After Delivery 1 Approved:');
    console.log('   Current stop index:', track.currentStopIndex);
    console.log('   Current stop title:', track.currentStop.title);
    console.log('   Phase:', track.phase);
    console.log('   All pickups done:', track.allPickupsDone);
    if (track.currentStopIndex !== 2 || track.phase !== 'PICKUP' || track.currentStop.type !== 'PICKUP') {
        throw new Error('Stage 2 failed! Expected currentStopIndex: 2, phase: PICKUP');
    }

    // Stage 3: Representative completes Pickup 2 (Stop 2)
    mockOrder.allLocationsInOrder[2].isCompleted = true;
    track = await DeliveryOrderTracker.getOrderTrack(mockOrder);
    console.log('\n📍 [Stage 3] After Pickup 2 Approved:');
    console.log('   Current stop index:', track.currentStopIndex);
    console.log('   Current stop title:', track.currentStop.title);
    console.log('   Phase:', track.phase);
    console.log('   All pickups done:', track.allPickupsDone);
    if (track.currentStopIndex !== 3 || track.phase !== 'DELIVERY' || track.currentStop.type !== 'DELIVERY') {
        throw new Error('Stage 3 failed! Expected currentStopIndex: 3, phase: DELIVERY');
    }

    // Stage 4: Representative completes Delivery 2 (Stop 3)
    mockOrder.allLocationsInOrder[3].isCompleted = true;
    mockOrder.status = 'delivered';
    track = await DeliveryOrderTracker.getOrderTrack(mockOrder);
    console.log('\n📍 [Stage 4] After Delivery 2 Approved:');
    console.log('   Current stop index:', track.currentStopIndex);
    console.log('   Phase:', track.phase);
    console.log('   Is all completed:', track.isAllCompleted);
    if (!track.isAllCompleted || track.phase !== 'COMPLETED') {
        throw new Error('Stage 4 failed! Expected isAllCompleted: true, phase: COMPLETED');
    }

    console.log('\n✅ ALL DELIVERY TRACKER SEQUENTIAL TESTS PASSED PERFECTLY! 🎉\n');
}

testDeliveryOrderTracker().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
