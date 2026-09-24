const { getBusinessOrderCompletionEmailHtml } = require('../services/emailService');

console.log('================================================================');
console.log('🧪 TEST: BUSINESS ORDER 1-PICKUP vs 2-PICKUP PHOTO TESTS 🧪');
console.log('================================================================\n');

// ─── SCENARIO 1: 1 Store Pickup, 2 Separate Deliveries ─────────────────────────
console.log('📌 SCENARIO 1: 1 Store Pickup (shared by all items), 2 Deliveries:');
const sharedPickupOrder = {
    storeOrderId: 5001,
    orderId: 5001,
    deliveryPrice: 1000,
    pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/merchant_store_pickup.jpg',
    pickupPhotos: ['https://res.cloudinary.com/demo/image/upload/merchant_store_pickup.jpg'],
    deliveryPhotos: [
        'https://res.cloudinary.com/demo/image/upload/customer1_delivery.jpg',
        'https://res.cloudinary.com/demo/image/upload/customer2_delivery.jpg'
    ],
    items: [
        {
            name: 'قميص رجالي',
            quantity: 1,
            price: 500,
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/customer1_delivery.jpg',
        },
        {
            name: 'بنطال جينز',
            quantity: 1,
            price: 500,
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/customer2_delivery.jpg',
        }
    ]
};

const html1 = getBusinessOrderCompletionEmailHtml(sharedPickupOrder, { firstName: 'علي' });

const p1_idx = html1.indexOf('قميص رجالي');
const p2_idx = html1.indexOf('بنطال جينز');

const p1_block = html1.substring(p1_idx, p2_idx);
const p2_block = html1.substring(p2_idx);

const p1_hasPickup = p1_block.includes('merchant_store_pickup.jpg');
const p1_hasDelivery = p1_block.includes('customer1_delivery.jpg');
const p2_hasPickup = p2_block.includes('merchant_store_pickup.jpg');
const p2_hasDelivery = p2_block.includes('customer2_delivery.jpg');

console.log('   - Item 1 has Store Pickup Photo:', p1_hasPickup ? '✅ PASS' : '❌ FAIL');
console.log('   - Item 1 has Delivery Photo 1:', p1_hasDelivery ? '✅ PASS' : '❌ FAIL');
console.log('   - Item 2 has Store Pickup Photo:', p2_hasPickup ? '✅ PASS' : '❌ FAIL');
console.log('   - Item 2 has Delivery Photo 2:', p2_hasDelivery ? '✅ PASS' : '❌ FAIL');


// ─── SCENARIO 2: 2 Separate Pickups, 2 Separate Deliveries ─────────────────────
console.log('\n📌 SCENARIO 2: 2 Separate Pickups, 2 Separate Deliveries:');
const distinctPickupsOrder = {
    storeOrderId: 5002,
    orderId: 5002,
    deliveryPrice: 1000,
    items: [
        {
            name: 'ساعة يد',
            quantity: 1,
            price: 500,
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/pickup_loc_1.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/deliv_loc_1.jpg',
        },
        {
            name: 'نظارة شمسية',
            quantity: 1,
            price: 500,
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/pickup_loc_2.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/deliv_loc_2.jpg',
        }
    ]
};

const html2 = getBusinessOrderCompletionEmailHtml(distinctPickupsOrder, { firstName: 'علي' });

const d1_idx = html2.indexOf('ساعة يد');
const d2_idx = html2.indexOf('نظارة شمسية');

const d1_block = html2.substring(d1_idx, d2_idx);
const d2_block = html2.substring(d2_idx);

const d1_p1 = d1_block.includes('pickup_loc_1.jpg') && !d1_block.includes('pickup_loc_2.jpg');
const d1_d1 = d1_block.includes('deliv_loc_1.jpg');
const d2_p2 = d2_block.includes('pickup_loc_2.jpg') && !d2_block.includes('pickup_loc_1.jpg');
const d2_d2 = d2_block.includes('deliv_loc_2.jpg');

console.log('   - Item 1 has Pickup 1 only:', d1_p1 ? '✅ PASS' : '❌ FAIL');
console.log('   - Item 1 has Delivery 1:', d1_d1 ? '✅ PASS' : '❌ FAIL');
console.log('   - Item 2 has Pickup 2 only:', d2_p2 ? '✅ PASS' : '❌ FAIL');
console.log('   - Item 2 has Delivery 2:', d2_d2 ? '✅ PASS' : '❌ FAIL');

if (p1_hasPickup && p1_hasDelivery && p2_hasPickup && p2_hasDelivery && d1_p1 && d1_d1 && d2_p2 && d2_d2) {
    console.log('\n🎉🎉 ALL BUSINESS PICKUP & DELIVERY PHOTO SCENARIOS PASSED 100%! 🎉🎉');
    process.exit(0);
} else {
    console.error('\n❌ Test failed!');
    process.exit(1);
}
