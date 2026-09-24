const { getBusinessOrderCompletionEmailHtml } = require('../services/emailService');

console.log('================================================================');
console.log('🧪 TEST: STRICT DISTINCT 2 PICKUPS & 2 DELIVERIES (NO REPETITION) 🧪');
console.log('================================================================\n');

const orderWithTasks = {
    storeOrderId: 6001,
    orderId: 6001,
    deliveryPrice: 1000,
    tasks: [
        {
            taskId: 1,
            deliveryDescription: 'منتج أ (Rolex)',
            itemPhotoBefore: 'https://res.cloudinary.com/demo/image/upload/pickup_photo_item_ONE.jpg',
            itemPhotoAfter: 'https://res.cloudinary.com/demo/image/upload/delivery_photo_item_ONE.jpg',
        },
        {
            taskId: 2,
            deliveryDescription: 'منتج ب (Perfume)',
            itemPhotoBefore: 'https://res.cloudinary.com/demo/image/upload/pickup_photo_item_TWO.jpg',
            itemPhotoAfter: 'https://res.cloudinary.com/demo/image/upload/delivery_photo_item_TWO.jpg',
        }
    ],
    items: [
        {
            name: 'منتج أ (Rolex)',
            quantity: 1,
            price: 500,
        },
        {
            name: 'منتج ب (Perfume)',
            quantity: 1,
            price: 500,
        }
    ]
};

const html = getBusinessOrderCompletionEmailHtml(orderWithTasks, { firstName: 'علي' });

const idx1 = html.indexOf('منتج أ (Rolex)');
const idx2 = html.indexOf('منتج ب (Perfume)');

const block1 = html.substring(idx1, idx2);
const block2 = html.substring(idx2);

console.log('--- Product 1 (Item 1) Checks ---');
const p1_hasP1 = block1.includes('pickup_photo_item_ONE.jpg');
const p1_hasNoP2 = !block1.includes('pickup_photo_item_TWO.jpg');
const p1_hasD1 = block1.includes('delivery_photo_item_ONE.jpg');
console.log('1. Product 1 has Pickup 1:', p1_hasP1 ? '✅ PASS' : '❌ FAIL');
console.log('2. Product 1 DOES NOT have Pickup 2:', p1_hasNoP2 ? '✅ PASS' : '❌ FAIL');
console.log('3. Product 1 has Delivery 1:', p1_hasD1 ? '✅ PASS' : '❌ FAIL');

console.log('\n--- Product 2 (Item 2) Checks ---');
const p2_hasP2 = block2.includes('pickup_photo_item_TWO.jpg');
const p2_hasNoP1 = !block2.includes('pickup_photo_item_ONE.jpg');
const p2_hasD2 = block2.includes('delivery_photo_item_TWO.jpg');
console.log('4. Product 2 has Pickup 2:', p2_hasP2 ? '✅ PASS' : '❌ FAIL');
console.log('5. Product 2 DOES NOT have Pickup 1 (NO REPETITION):', p2_hasNoP1 ? '✅ PASS' : '❌ FAIL');
console.log('6. Product 2 has Delivery 2:', p2_hasD2 ? '✅ PASS' : '❌ FAIL');

if (p1_hasP1 && p1_hasNoP2 && p1_hasD1 && p2_hasP2 && p2_hasNoP1 && p2_hasD2) {
    console.log('\n🎉🎉 SUCCESS: EXACT DISTINCT PICKUP & DELIVERY PHOTOS RENDERED FOR BOTH PRODUCTS WITHOUT ANY REPETITION! 🎉🎉');
    process.exit(0);
} else {
    console.error('\n❌ Test failed!');
    process.exit(1);
}
