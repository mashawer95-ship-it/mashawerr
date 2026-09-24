const {
    getDeliveryOrderCompletionEmailHtml,
    sendDeliveryOrderCompletionEmail,
    sendBusinessOrderCompletionEmail,
    sendOrderCompletionEmail
} = require('../services/emailService');

const mockDeliveryOrder = {
    orderId: 888,
    totalDeliveryPrice: 1500,
    totalPrice: 1.500,
    deliveredAt: new Date(),
    pickupPhoto: 'https://cloudinary.com/test_pickup.jpg',
    deliveryPhoto: 'https://cloudinary.com/test_delivery.jpg',
    tasks: [{
        taskId: 1,
        deliveryDescription: 'طرد ملابس',
        googleMapAddressFrom: 'مدينة الكويت',
        googleMapAddressTo: 'حولي',
        itemPhotoBefore: 'https://cloudinary.com/test_pickup.jpg',
        itemPhotoAfter: 'https://cloudinary.com/test_delivery.jpg'
    }]
};

const html = getDeliveryOrderCompletionEmailHtml(mockDeliveryOrder, { firstName: 'أحمد' });

console.log('--- Delivery Email Photo Check ---');
console.log('Includes Pickup Photo URL:', html.includes('https://cloudinary.com/test_pickup.jpg'));
console.log('Includes Delivery Photo URL:', html.includes('https://cloudinary.com/test_delivery.jpg'));
console.log('Includes Pickup Photo Label:', html.includes('صورة الاستلام (قبل)'));
console.log('Includes Delivery Photo Label:', html.includes('صورة التسليم (بعد)'));
console.log('Functions separated properly:');
console.log('sendDeliveryOrderCompletionEmail is function:', typeof sendDeliveryOrderCompletionEmail === 'function');
console.log('sendBusinessOrderCompletionEmail is function:', typeof sendBusinessOrderCompletionEmail === 'function');
console.log('sendOrderCompletionEmail is function:', typeof sendOrderCompletionEmail === 'function');
