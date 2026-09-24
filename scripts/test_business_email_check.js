const { getBusinessOrderCompletionEmailHtml } = require('../services/emailService');

const mockBusinessOrder = {
    storeOrderId: 555,
    deliveryPrice: 2500, // 2.500 KD
    totalPrice: 10000, // Products subtotal = 10.000 KD
    items: [
        {
            name: 'ساعة يد فاخرة',
            quantity: 2,
            price: 5000, // 5.000 KD each -> 10.000 KD subtotal
            deliveryLocation: { address: 'الكويت - حولي - شارع تونس - قطعة 3 - مجمع...' }
        }
    ],
    subOrders: [
        {
            pickupPhoto: 'https://res.cloudinary.com/demo/image/upload/sample_pickup.jpg',
            deliveryPhoto: 'https://res.cloudinary.com/demo/image/upload/sample_delivery.jpg'
        }
    ]
};

const html = getBusinessOrderCompletionEmailHtml(mockBusinessOrder, { firstName: 'علي' });

console.log('--- 🧪 Business Order Email Verification Check ---');
console.log('1. Products Subtotal (10,000.000 د.ك):', html.includes('10,000.000 د.ك'));
console.log('2. Delivery Fee (2,500.000 د.ك):', html.includes('2,500.000 د.ك'));
console.log('3. Grand Total Paid (12,500.000 د.ك):', html.includes('12,500.000 د.ك'));
console.log('4. Pickup Photo present:', html.includes('sample_pickup.jpg'));
console.log('5. Delivery Photo (صورة التسليم) present:', html.includes('sample_delivery.jpg'));
