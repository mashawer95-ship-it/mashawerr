const { sendOrderCompletionEmail, sendDeliveryOrderCompletionEmail } = require('../services/emailService');

console.log('--- Testing Router Discrimination ---');

const mockDeliveryOrder = {
    orderId: 777,
    clientId: 'user123',
    totalDeliveryPrice: 2000,
    totalPrice: 2.000,
    deliveredAt: new Date(),
    pickupPhoto: 'https://cloudinary.com/test_pickup.jpg',
    deliveryPhoto: 'https://cloudinary.com/test_delivery.jpg',
    tasks: [{
        taskId: 1,
        deliveryDescription: 'اختبار توصيل طرد',
        googleMapAddressFrom: 'الكويت',
        googleMapAddressTo: 'السالمية'
    }]
};

console.log('Sending delivery order completion email...');
sendDeliveryOrderCompletionEmail(mockDeliveryOrder)
    .then(res => console.log('sendDeliveryOrderCompletionEmail Result:', res))
    .catch(err => console.error('Error:', err.message));
