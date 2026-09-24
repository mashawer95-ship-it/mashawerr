const { DeliveryOrderTracker } = require('../services/DeliveryOrderTracker');

async function runTest() {
    console.log('Testing sequential updates in podController flow...');

    const order = {
        orderId: 2002,
        status: 'processing',
        allLocationsInOrder: [
            { name: 'مطعم أ', isFrom: true, isCompleted: false },
            { name: 'عميل أ', isFrom: false, isCompleted: false },
            { name: 'مطعم ب', isFrom: true, isCompleted: false },
            { name: 'عميل ب', isFrom: false, isCompleted: false }
        ]
    };

    // 1. Simulate completion of stop 0 (pickup 1)
    order.allLocationsInOrder[0].isCompleted = true;
    let track1 = await DeliveryOrderTracker.getOrderTrack(order);
    console.log('Stop 0 completed -> Next stop index:', track1.currentStopIndex, 'phase:', track1.phase);
    if (track1.currentStopIndex !== 1 || track1.phase !== 'DELIVERY') {
        throw new Error('Expected next stop to be 1 (DELIVERY)');
    }

    // 2. Simulate completion of stop 1 (delivery 1)
    order.allLocationsInOrder[1].isCompleted = true;
    let track2 = await DeliveryOrderTracker.getOrderTrack(order);
    console.log('Stop 1 completed -> Next stop index:', track2.currentStopIndex, 'phase:', track2.phase);
    if (track2.currentStopIndex !== 2 || track2.phase !== 'PICKUP') {
        throw new Error('Expected next stop to be 2 (PICKUP)');
    }

    // 3. Simulate completion of stop 2 (pickup 2)
    order.allLocationsInOrder[2].isCompleted = true;
    let track3 = await DeliveryOrderTracker.getOrderTrack(order);
    console.log('Stop 2 completed -> Next stop index:', track3.currentStopIndex, 'phase:', track3.phase);
    if (track3.currentStopIndex !== 3 || track3.phase !== 'DELIVERY') {
        throw new Error('Expected next stop to be 3 (DELIVERY)');
    }

    // 4. Simulate completion of stop 3 (delivery 2)
    order.allLocationsInOrder[3].isCompleted = true;
    order.status = 'delivered';
    let track4 = await DeliveryOrderTracker.getOrderTrack(order);
    console.log('Stop 3 completed -> All completed:', track4.isAllCompleted, 'phase:', track4.phase);
    if (!track4.isAllCompleted || track4.phase !== 'COMPLETED') {
        throw new Error('Expected all completed');
    }

    console.log('✅ Sequential Pod Completion Simulation Passed 100%!');
}

runTest().catch(e => {
    console.error(e);
    process.exit(1);
});
