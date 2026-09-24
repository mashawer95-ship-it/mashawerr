const { getBusinessOrderCompletionEmailHtml } = require('../services/emailService');

console.log('================================================================');
console.log('🧪 TEST: ADMIN-MATCHING BUSINESS PROOF PHOTOS & DELIVERY FEE 🧪');
console.log('================================================================\n');

const mockOrder = {
    storeOrderId: 1005,
    orderId: 1005,
    isBusinessOrder: true,
    orderCategory: 'business',
    deliveryPrice: 1000, // 1000 KD (ألف دينار)
    totalPrice: 2000,
    items: [
        {
            name: 'ساعة يد أصلية',
            quantity: 1,
            price: 500, // 500 KD
            subtotal: 500,
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/item_pickup_photo_1.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/item_delivery_photo_1.jpg',
            deliveryLocation: { address: 'الكويت - العاصمة - برج التجارية' }
        },
        {
            name: 'حقيبة جلد طبيعي',
            quantity: 1,
            price: 500, // 500 KD
            subtotal: 500,
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/item_pickup_photo_2.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/item_delivery_photo_2.jpg',
            deliveryLocation: { address: 'الكويت - العاصمة - برج التجارية' }
        }
    ],
    pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/order_general_pickup.jpg',
    deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/order_general_delivery.jpg'
};

const html = getBusinessOrderCompletionEmailHtml(mockOrder, { firstName: 'علي' });

console.log('1. Delivery Fee Check (1,000.000 د.ك):', html.includes('1,000.000 د.ك'));
console.log('2. Products Subtotal Check (1,000.000 د.ك):', html.includes('1,000.000 د.ك'));
console.log('3. Grand Total Paid Check (2,000.000 د.ك):', html.includes('2,000.000 د.ك'));
console.log('4. Item 1 Pickup Photo:', html.includes('item_pickup_photo_1.jpg'));
console.log('5. Item 1 Delivery Photo:', html.includes('item_delivery_photo_1.jpg'));
console.log('6. Item 2 Pickup Photo:', html.includes('item_pickup_photo_2.jpg'));
console.log('7. Item 2 Delivery Photo:', html.includes('item_delivery_photo_2.jpg'));

if (html.includes('1,000.000 د.ك') &&
    html.includes('2,000.000 د.ك') &&
    html.includes('item_pickup_photo_1.jpg') &&
    html.includes('item_delivery_photo_1.jpg') &&
    html.includes('item_pickup_photo_2.jpg') &&
    html.includes('item_delivery_photo_2.jpg')) {
    console.log('\n🎉 ALL ADMIN-MATCHING PROOF PHOTO & DELIVERY PRICE TESTS PASSED WITH 100% SUCCESS!');
    process.exit(0);
} else {
    console.error('\n❌ Test failed!');
    process.exit(1);
}
