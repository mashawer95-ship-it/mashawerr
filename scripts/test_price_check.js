const { getDeliveryOrderCompletionEmailHtml } = require('../services/emailService');

const mockOrder = {
    orderId: 999,
    originalDeliveryPrice: 2500, // 2500 fils original (2.500 KD)
    totalDeliveryPrice: 2000, // 2000 fils after discount (2.000 KD)
    discountAmount: 500, // 500 fils (0.500 KD)
    totalPrice: 0, // 0 provided -> should calculate 2.000 KD from totalDeliveryPrice
    deliveredAt: new Date(),
    tasks: [{
        taskId: 1,
        deliveryDescription: 'اختبار توصيل طرد',
        googleMapAddressFrom: 'منطقة الاستلام',
        googleMapAddressTo: 'منطقة التسليم'
    }]
};

const html = getDeliveryOrderCompletionEmailHtml(mockOrder, { firstName: 'مبتكر' });
console.log('Price test check:');
console.log('Includes 2.500 د.ك:', html.includes('2.500 د.ك'));
console.log('Includes 2.000 د.ك (Total):', html.includes('2.000 د.ك'));
console.log('Includes #C19418:', html.includes('#C19418'));
console.log('Includes Emoji 🎉:', html.includes('🎉'));
