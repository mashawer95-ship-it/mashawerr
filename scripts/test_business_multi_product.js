const { getBusinessOrderCompletionEmailHtml } = require('../services/emailService');

console.log('--- 🧪 STARTING BUSINESS MULTI-PRODUCT DELIVERY FLOW TEST ---');

// 1. Mock Sub-orders with distinct photos
const subOrder1 = {
    _id: '64f1a0000000000000000001',
    storeOrderId: 501,
    parentGroupId: 'group-uuid-test-999',
    status: 'delivered',
    pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/product_1_pickup.jpg',
    deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/product_1_delivery.jpg',
    items: [
        {
            product: 'prod-1',
            name: 'ساعة رجالية فاخرة (المنتج الأول)',
            quantity: 1,
            price: 12000,
            subtotal: 12000,
            productImage: 'https://res.cloudinary.com/demo/image/upload/watch.jpg',
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/product_1_pickup.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/product_1_delivery.jpg'
        }
    ],
    deliveryLocation: { address: 'الكويت - العاصمة - برج التجارية' }
};

const subOrder2 = {
    _id: '64f1a0000000000000000002',
    storeOrderId: 501,
    parentGroupId: 'group-uuid-test-999',
    status: 'delivered',
    pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/product_2_pickup.jpg',
    deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/product_2_delivery.jpg',
    items: [
        {
            product: 'prod-2',
            name: 'حقيبة سفر أنيقة (المنتج الثاني)',
            quantity: 1,
            price: 18000,
            subtotal: 18000,
            productImage: 'https://res.cloudinary.com/demo/image/upload/bag.jpg',
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/product_2_pickup.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/product_2_delivery.jpg'
        }
    ],
    deliveryLocation: { address: 'الكويت - حولي - شارع تونس' }
};

const mockGroupOrder = {
    parentGroupId: 'group-uuid-test-999',
    storeOrderId: 501,
    deliveryPrice: 2000,
    subOrders: [subOrder1, subOrder2]
};

// Test HTML generation
const html = getBusinessOrderCompletionEmailHtml(mockGroupOrder, { firstName: 'محمد', lastName: 'علي' });

console.log('\n--- 🔍 HTML Validation Assertions ---');

// Assert 1: Product 1 has its pickup and delivery photo
const p1PickupOk = html.includes('product_1_pickup.jpg');
const p1DeliveryOk = html.includes('product_1_delivery.jpg');
console.log('✅ Assert 1 - Product 1 Pickup photo present:', p1PickupOk);
console.log('✅ Assert 2 - Product 1 Delivery photo present:', p1DeliveryOk);

// Assert 3: Product 2 has its OWN pickup and delivery photo
const p2PickupOk = html.includes('product_2_pickup.jpg');
const p2DeliveryOk = html.includes('product_2_delivery.jpg');
console.log('✅ Assert 3 - Product 2 Pickup photo present:', p2PickupOk);
console.log('✅ Assert 4 - Product 2 Delivery photo present:', p2DeliveryOk);

// Assert 5: Product 1 photo count is exactly 2 (href + src) and does NOT leak into Product 2
const p1PickupMatches = (html.match(/product_1_pickup\.jpg/g) || []).length;
const p2PickupMatches = (html.match(/product_2_pickup\.jpg/g) || []).length;
console.log(`✅ Assert 5 - Product 1 Pickup count in HTML: ${p1PickupMatches} (href + img src = 2)`);
console.log(`✅ Assert 6 - Product 2 Pickup count in HTML: ${p2PickupMatches} (href + img src = 2)`);

if (p1PickupOk && p1DeliveryOk && p2PickupOk && p2DeliveryOk && p1PickupMatches === 2 && p2PickupMatches === 2) {
    console.log('\n🎉 ALL MULTI-PRODUCT EMAIL TESTS PASSED SUCCESSFULLY!');
} else {
    console.error('\n❌ TEST FAILED! Check outputs above.');
    process.exit(1);
}
