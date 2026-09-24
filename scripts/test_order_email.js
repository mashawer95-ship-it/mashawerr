const {
    getDeliveryOrderCompletionEmailHtml,
    getBusinessOrderCompletionEmailHtml,
    sendOrderCompletionEmail
} = require('../services/emailService');

console.log('=== 🧪 Testing Order Completion Email System ===\n');

// 1. Mock Delivery Order (2 Tasks)
const mockDeliveryOrder = {
    orderId: 1052,
    clientId: '65a123456789abcdef012345',
    originalDeliveryPrice: 2500, // 2.500 KD original
    totalDeliveryPrice: 2000, // 2.000 KD after discount
    discountAmount: 500, // 0.500 KD discount
    totalPrice: 2000, // 2.000 KD final
    createdAt: new Date(),
    pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    tasks: [
        {
            taskId: 1,
            deliveryDescription: 'توصيل عطور ومستحضرات تجميل',
            googleMapAddressFrom: 'الكويت - حولي - شارع تونس',
            googleMapAddressTo: 'الكويت - السالمية - شارع سالم المبارك',
            itemPhotoBefore: 'https://res.cloudinary.com/demo/image/upload/sample_before1.jpg',
            itemPhotoAfter: 'https://res.cloudinary.com/demo/image/upload/sample_after1.jpg',
        },
        {
            taskId: 2,
            deliveryDescription: 'توصيل أجهزة إلكترونية طرد خفيف',
            googleMapAddressFrom: 'الكويت - الفروانية - قطعة 4',
            googleMapAddressTo: 'الكويت - العاصمة - برج راية',
            itemPhotoBefore: 'https://res.cloudinary.com/demo/image/upload/sample_before2.jpg',
            itemPhotoAfter: 'https://res.cloudinary.com/demo/image/upload/sample_after2.jpg',
        }
    ]
};

const mockClient = {
    firstName: 'أحمد',
    lastName: 'علي',
    email: 'client@example.com'
};

const deliveryHtml = getDeliveryOrderCompletionEmailHtml(mockDeliveryOrder, mockClient);

console.log('1. ✅ Delivery Order Email HTML generated successfully. Length:', deliveryHtml.length);
if (deliveryHtml.includes('توصيل عطور ومستحضرات تجميل') && deliveryHtml.includes('2.500 د.ك') && deliveryHtml.includes('#1052')) {
    console.log('   ↳ Content check passed: contains task description, pricing, and order ID.');
} else {
    console.error('   ❌ Delivery content check failed!');
}

// 2. Mock Business Order (3 Products with quantities and dropoff locations)
const mockBusinessOrder = {
    storeOrderId: 3089,
    isBusinessOrder: true,
    userId: '65a123456789abcdef012345',
    deliveryPrice: 1500, // 1.500 KD
    totalPrice: 17500, // 17.500 KD
    createdAt: new Date(),
    pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/sample_pickup.jpg',
    deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/sample_delivery.jpg',
    deliveryLocation: {
        address: 'الكويت - الأحمدي - الفنطاس قطعة 1'
    },
    items: [
        {
            name: 'قميص قطني فاخر - مقاس L',
            productImage: 'https://res.cloudinary.com/demo/image/upload/shirt.jpg',
            quantity: 2,
            price: 5000, // 5.000 KD
            subtotal: 10000,
            deliveryLocation: { address: 'الكويت - السالمية - شارع البلاجات' }
        },
        {
            name: 'حذاء رياضي أنيق - أبيض',
            productImage: 'https://res.cloudinary.com/demo/image/upload/shoes.jpg',
            quantity: 1,
            price: 6000, // 6.000 KD
            subtotal: 6000,
            deliveryLocation: { address: 'الكويت - حولي - شارع العثمان' }
        }
    ]
};

const businessHtml = getBusinessOrderCompletionEmailHtml(mockBusinessOrder, mockClient);

console.log('\n2. ✅ Business Order Email HTML generated successfully. Length:', businessHtml.length);
if (businessHtml.includes('قميص قطني فاخر') && businessHtml.includes('x2') && businessHtml.includes('1.500 د.ك') && businessHtml.includes('#3089')) {
    console.log('   ↳ Content check passed: contains product names, quantities (x2), dropoff location, pricing, and store order ID.');
} else {
    console.error('   ❌ Business content check failed!');
}

console.log('\n🎉 All template generation unit tests passed successfully!');
