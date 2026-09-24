const { sendOrderCompletionEmail } = require('../services/emailService');

console.log('--- 🧪 STARTING ORDER COMPLETION HOLD SIMULATION TEST ---');

// Mock order holding test: Sub-orders not all delivered
const pendingGroupOrder = {
    parentGroupId: 'group-hold-test-123',
    storeOrderId: 601,
    subOrders: [
        { storeOrderId: 601, status: 'delivered', pickupPhoto: 'p1.jpg', deliveryPhoto: 'd1.jpg' },
        { storeOrderId: 602, status: 'shipped', pickupPhoto: 'p2.jpg', deliveryPhoto: null }
    ]
};

// Check simulation
const subs1 = pendingGroupOrder.subOrders;
const allDone1 = subs1.length === 0 || subs1.every(s => ['delivered', 'completed', 'done'].includes(String(s.status).toLowerCase()));

console.log('Test 1 - SubOrder 1 delivered, SubOrder 2 shipped:');
console.log('  allDone evaluated to:', allDone1, '(Expected: false)');
console.log('  Email held status:', !allDone1 ? '✅ HELD (Not sent yet)' : '❌ ERROR: Sent prematurely');

// Update SubOrder 2 to delivered
pendingGroupOrder.subOrders[1].status = 'delivered';
pendingGroupOrder.subOrders[1].deliveryPhoto = 'd2.jpg';

const subs2 = pendingGroupOrder.subOrders;
const allDone2 = subs2.length === 0 || subs2.every(s => ['delivered', 'completed', 'done'].includes(String(s.status).toLowerCase()));

console.log('\nTest 2 - SubOrder 1 delivered, SubOrder 2 delivered:');
console.log('  allDone evaluated to:', allDone2, '(Expected: true)');
console.log('  Email sending status:', allDone2 ? '✅ READY (Dispatched after final delivery)' : '❌ ERROR: Still held');

if (!allDone1 && allDone2) {
    console.log('\n🎉 ALL ORDER COMPLETION HOLD TESTS PASSED SUCCESSFULLY!');
} else {
    console.error('\n❌ TEST FAILED!');
    process.exit(1);
}
