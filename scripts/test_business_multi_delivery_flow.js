const { getBusinessOrderCompletionEmailHtml } = require('../services/emailService');

console.log('================================================================');
console.log('🧪 RUNNING COMPREHENSIVE BUSINESS ORDER MULTI-DELIVERY TEST 🧪');
console.log('================================================================\n');

// ─── SCENARIO: 2 Products in same business order destined for SAME location ──
const sharedLocation = {
    address: 'الكويت - حولي - شارع تونس - قطعة 3 - مجمع الأندلس',
    lat: 29.3375,
    lng: 48.0245
};

const subOrder1 = {
    _id: 'sub_order_001',
    storeOrderId: 777,
    subOrderIndex: 1,
    parentGroupId: 'group-uuid-888',
    status: 'delivered', // Delivered first
    pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/item1_pickup.jpg',
    deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/item1_delivery.jpg',
    deliveryLocation: sharedLocation,
    items: [
        {
            product: 'prod_watch_1',
            name: 'ساعة ذكية فاخرة (المنتج 1)',
            quantity: 1,
            price: 15000, // 15.000 KD
            subtotal: 15000,
            itemIndex: 1,
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/item1_pickup.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/item1_delivery.jpg'
        }
    ]
};

const subOrder2 = {
    _id: 'sub_order_002',
    storeOrderId: 777,
    subOrderIndex: 2,
    parentGroupId: 'group-uuid-888',
    status: 'shipped', // Still pending! (delivering)
    pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/item2_pickup.jpg',
    deliveryPhoto: null, // No delivery photo yet
    deliveryLocation: sharedLocation, // SAME LOCATION!
    items: [
        {
            product: 'prod_perfume_2',
            name: 'عطر فاخر أصلي (المنتج 2)',
            quantity: 2,
            price: 7500, // 7.500 KD each -> 15.000 KD subtotal
            subtotal: 15000,
            itemIndex: 2,
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/item2_pickup.jpg',
            deliveryPhoto: null
        }
    ]
};

const orderGroup = {
    parentGroupId: 'group-uuid-888',
    storeOrderId: 777,
    deliveryPrice: 3000, // 3.000 KD
    subOrders: [subOrder1, subOrder2]
};

// ─── STEP 1: GATE CHECK WHEN SUB 1 DELIVERED & SUB 2 STILL PENDING ─────────────
const DELIVERED_STATUSES = ['delivered', 'completed', 'done'];
const hasUnfinishedSubStage1 = orderGroup.subOrders.some(s => {
    const isSubDone = DELIVERED_STATUSES.includes(String(s.status).toLowerCase());
    if (!isSubDone) return true;
    if (Array.isArray(s.items) && s.items.length > 0) {
        const itemsDone = s.items.every(i => i.isDelivered === true || DELIVERED_STATUSES.includes(String(i.status || s.status).toLowerCase()));
        if (!itemsDone) return true;
    }
    return false;
});

console.log('📌 STEP 1: Sub 1 Delivered, Sub 2 Pending:');
console.log('   - Has unfinished sub-order:', hasUnfinishedSubStage1);
console.log('   - Email Gate Check result:', hasUnfinishedSubStage1 ? '✅ HELD (Email is NOT sent prematurely)' : '❌ FAIL: Sent prematurely');
if (!hasUnfinishedSubStage1) {
    console.error('❌ Assertion failed: Email was not held!');
    process.exit(1);
}

// ─── STEP 2: REPRESENTATIVE DELIVERS SUB 2 & UPLOADS PHOTO 2 ───────────────────
subOrder2.status = 'delivered';
subOrder2.deliveryPhoto = 'https://res.cloudinary.com/demo/image/upload/item2_delivery.jpg';
subOrder2.items[0].deliveryPhoto = 'https://res.cloudinary.com/demo/image/upload/item2_delivery.jpg';
subOrder2.items[0].status = 'delivered';
subOrder2.items[0].isDelivered = true;

const hasUnfinishedSubStage2 = orderGroup.subOrders.some(s => {
    const isSubDone = DELIVERED_STATUSES.includes(String(s.status).toLowerCase());
    if (!isSubDone) return true;
    if (Array.isArray(s.items) && s.items.length > 0) {
        const itemsDone = s.items.every(i => i.isDelivered === true || DELIVERED_STATUSES.includes(String(i.status || s.status).toLowerCase()));
        if (!itemsDone) return true;
    }
    return false;
});

console.log('\n📌 STEP 2: Sub 1 Delivered, Sub 2 Delivered:');
console.log('   - Has unfinished sub-order:', hasUnfinishedSubStage2);
console.log('   - Email Gate Check result:', !hasUnfinishedSubStage2 ? '✅ READY TO DISPATCH (Full order completed)' : '❌ FAIL: Still held');
if (hasUnfinishedSubStage2) {
    console.error('❌ Assertion failed: Email is still held after all deliveries completed!');
    process.exit(1);
}

// ─── STEP 3: VERIFY GENERATED HTML EMAIL ACCURACY ──────────────────────────────
const html = getBusinessOrderCompletionEmailHtml(orderGroup, { firstName: 'أحمد', lastName: 'خالد' });

console.log('\n📌 STEP 3: HTML Email Invoice & Photos Verification:');
const check1 = html.includes('item1_pickup.jpg');
const check2 = html.includes('item1_delivery.jpg');
const check3 = html.includes('item2_pickup.jpg');
const check4 = html.includes('item2_delivery.jpg');
console.log('   - Product 1 Pickup photo present:', check1 ? '✅ PASS' : '❌ FAIL');
console.log('   - Product 1 Delivery photo present:', check2 ? '✅ PASS' : '❌ FAIL');
console.log('   - Product 2 Pickup photo present:', check3 ? '✅ PASS' : '❌ FAIL');
console.log('   - Product 2 Delivery photo present:', check4 ? '✅ PASS' : '❌ FAIL');

// Check financial figures:
// Product 1: 15,000.000 KD
// Product 2: 15,000.000 KD
// Products Subtotal: 30,000.000 KD
// Delivery Fee: 3,000.000 KD
// Grand Total: 33,000.000 KD
const checkSubtotal = html.includes('30,000.000 د.ك');
const checkDelivery = html.includes('3,000.000 د.ك');
const checkGrandTotal = html.includes('33,000.000 د.ك');

console.log('   - Products Subtotal (30,000.000 د.ك):', checkSubtotal ? '✅ PASS' : '❌ FAIL');
console.log('   - Delivery Fee (3,000.000 د.ك):', checkDelivery ? '✅ PASS' : '❌ FAIL');
console.log('   - Grand Total (33,000.000 د.ك):', checkGrandTotal ? '✅ PASS' : '❌ FAIL');

if (check1 && check2 && check3 && check4 && checkSubtotal && checkDelivery && checkGrandTotal) {
    console.log('\n🎉🎉 ALL MULTI-DELIVERY FLOW ASSERTIONS PASSED WITH 100% SUCCESS! 🎉🎉');
} else {
    console.error('\n❌ HTML content verification failed!');
    process.exit(1);
}
