const { getBusinessOrderCompletionEmailHtml } = require('../services/emailService');

console.log('================================================================');
console.log('🧪 TEST: ADMIN ORDER TASKS DISTINCT PHOTOS & REMOVE GENERAL PHOTOS 🧪');
console.log('================================================================\n');

const mockMultiItemOrder = {
    storeOrderId: 2026,
    orderId: 2026,
    deliveryPrice: 1000, // 1000 KD
    totalPrice: 2000,
    items: [
        {
            name: 'ساعة رولكس فاخرة',
            quantity: 1,
            price: 500,
            subtotal: 500,
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/rolex_pickup_1.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/rolex_delivery_1.jpg',
            deliveryLocation: { address: 'الكويت - برج الحمراء' }
        },
        {
            name: 'عطر فرنسي متميز',
            quantity: 1,
            price: 500,
            subtotal: 500,
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/perfume_pickup_2.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/perfume_delivery_2.jpg',
            deliveryLocation: { address: 'الكويت - الأفنيوز' }
        }
    ],
    // tasks array matching Admin OrderTasks
    tasks: [
        {
            taskId: 1,
            deliveryDescription: 'ساعة رولكس فاخرة (x1)',
            itemPhotoBefore: 'https://res.cloudinary.com/demo/image/upload/rolex_pickup_1.jpg',
            itemPhotoAfter: 'https://res.cloudinary.com/demo/image/upload/rolex_delivery_1.jpg',
        },
        {
            taskId: 2,
            deliveryDescription: 'عطر فرنسي متميز (x1)',
            itemPhotoBefore: 'https://res.cloudinary.com/demo/image/upload/perfume_pickup_2.jpg',
            itemPhotoAfter: 'https://res.cloudinary.com/demo/image/upload/perfume_delivery_2.jpg',
        }
    ]
};

const html = getBusinessOrderCompletionEmailHtml(mockMultiItemOrder, { firstName: 'محمد' });

// 1. Check Product 1 photos
const hasRolexPickup = html.includes('rolex_pickup_1.jpg');
const hasRolexDelivery = html.includes('rolex_delivery_1.jpg');
console.log('1. Rolex (Item 1) Pickup Photo present:', hasRolexPickup ? '✅ PASS' : '❌ FAIL');
console.log('2. Rolex (Item 1) Delivery Photo present:', hasRolexDelivery ? '✅ PASS' : '❌ FAIL');

// 2. Check Product 2 photos
const hasPerfumePickup = html.includes('perfume_pickup_2.jpg');
const hasPerfumeDelivery = html.includes('perfume_delivery_2.jpg');
console.log('3. Perfume (Item 2) Pickup Photo present:', hasPerfumePickup ? '✅ PASS' : '❌ FAIL');
console.log('4. Perfume (Item 2) Delivery Photo present:', hasPerfumeDelivery ? '✅ PASS' : '❌ FAIL');

// 3. Check that "صور التوصيل المعتمدة للطلب" is completely removed
const hasGeneralPhotosTitle = html.includes('صور التوصيل المعتمدة للطلب');
console.log('5. General Proof Photos section removed:', !hasGeneralPhotosTitle ? '✅ PASS' : '❌ FAIL');

// 4. Check prices formatting (1000 KD -> 1,000.000 د.ك)
const hasFormattedDelivery = html.includes('1,000.000 د.ك');
const hasFormattedGrandTotal = html.includes('2,000.000 د.ك');
console.log('6. Delivery price formatted as 1,000.000 د.ك:', hasFormattedDelivery ? '✅ PASS' : '❌ FAIL');
console.log('7. Grand total formatted as 2,000.000 د.ك:', hasFormattedGrandTotal ? '✅ PASS' : '❌ FAIL');

if (hasRolexPickup && hasRolexDelivery && hasPerfumePickup && hasPerfumeDelivery && !hasGeneralPhotosTitle && hasFormattedDelivery && hasFormattedGrandTotal) {
    console.log('\n🎉 ALL DISTINCT TASK PHOTOS & FORMATTING TESTS PASSED 100%!');
    process.exit(0);
} else {
    console.error('\n❌ Test failed assertions!');
    process.exit(1);
}
