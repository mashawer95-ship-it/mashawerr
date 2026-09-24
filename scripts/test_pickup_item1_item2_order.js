const { getBusinessOrderCompletionEmailHtml } = require('../services/emailService');

console.log('================================================================');
console.log('🧪 TEST: VERIFY EXACT ITEM 1 & ITEM 2 PICKUP / DELIVERY ISOLATION 🧪');
console.log('================================================================\n');

const testOrder = {
    storeOrderId: 3001,
    orderId: 3001,
    deliveryPrice: 1000,
    items: [
        {
            name: 'منتج أ (Product 1)',
            quantity: 1,
            price: 500,
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/exact_pickup_item_1.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/exact_delivery_item_1.jpg',
        },
        {
            name: 'منتج ب (Product 2)',
            quantity: 1,
            price: 500,
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/exact_pickup_item_2.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/exact_delivery_item_2.jpg',
        }
    ]
};

const html = getBusinessOrderCompletionEmailHtml(testOrder, { firstName: 'علي' });

// Extract Product 1 and Product 2 blocks
const p1Index = html.indexOf('منتج أ (Product 1)');
const p2Index = html.indexOf('منتج ب (Product 2)');

const p1Block = html.substring(p1Index, p2Index);
const p2Block = html.substring(p2Index);

console.log('--- Checking Product 1 Block ---');
console.log('P1 contains Pickup 1:', p1Block.includes('exact_pickup_item_1.jpg') ? '✅ PASS' : '❌ FAIL');
console.log('P1 DOES NOT contain Pickup 2:', !p1Block.includes('exact_pickup_item_2.jpg') ? '✅ PASS' : '❌ FAIL');
console.log('P1 contains Delivery 1:', p1Block.includes('exact_delivery_item_1.jpg') ? '✅ PASS' : '❌ FAIL');

console.log('\n--- Checking Product 2 Block ---');
console.log('P2 contains Pickup 2:', p2Block.includes('exact_pickup_item_2.jpg') ? '✅ PASS' : '❌ FAIL');
console.log('P2 DOES NOT contain Pickup 1:', !p2Block.includes('exact_pickup_item_1.jpg') ? '✅ PASS' : '❌ FAIL');
console.log('P2 contains Delivery 2:', p2Block.includes('exact_delivery_item_2.jpg') ? '✅ PASS' : '❌ FAIL');

const isP1Correct = p1Block.includes('exact_pickup_item_1.jpg') && !p1Block.includes('exact_pickup_item_2.jpg') && p1Block.includes('exact_delivery_item_1.jpg');
const isP2Correct = p2Block.includes('exact_pickup_item_2.jpg') && !p2Block.includes('exact_pickup_item_1.jpg') && p2Block.includes('exact_delivery_item_2.jpg');

if (isP1Correct && isP2Correct) {
    console.log('\n🎉 SUCCESS: Product 1 and Product 2 have 100% isolated and correct pickup & delivery photos!');
    process.exit(0);
} else {
    console.error('\n❌ Isolation test failed!');
    process.exit(1);
}
