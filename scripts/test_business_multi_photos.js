const { getBusinessOrderCompletionEmailHtml } = require('../services/emailService');

const mockMultiBusinessOrder = {
    storeOrderId: 555,
    parentGroupId: 'uuid-group-123',
    isBusinessOrder: true,
    subOrders: [
        {
            _id: 'sub_1',
            storeOrderId: 555,
            pickupPhoto: 'https://cloudinary.com/product1_pickup.jpg',
            deliveryPhoto: 'https://cloudinary.com/product1_delivery.jpg',
            items: [
                {
                    name: 'منتج عسل سدر أصلي',
                    quantity: 1,
                    price: 15.000,
                    subtotal: 15.000,
                    pickupPhoto: 'https://cloudinary.com/product1_pickup.jpg',
                    deliveryPhoto: 'https://cloudinary.com/product1_delivery.jpg'
                }
            ]
        },
        {
            _id: 'sub_2',
            storeOrderId: 556,
            pickupPhoto: 'https://cloudinary.com/product2_pickup.jpg',
            deliveryPhoto: 'https://cloudinary.com/product2_delivery.jpg',
            items: [
                {
                    name: 'منتج زيت زيتون بكر',
                    quantity: 2,
                    price: 8.000,
                    subtotal: 16.000,
                    pickupPhoto: 'https://cloudinary.com/product2_pickup.jpg',
                    deliveryPhoto: 'https://cloudinary.com/product2_delivery.jpg'
                }
            ]
        }
    ]
};

const html = getBusinessOrderCompletionEmailHtml(mockMultiBusinessOrder, { firstName: 'علي' });

console.log('--- Multi-Product Business Order Email Test ---');
console.log('Includes Product 1 Name:', html.includes('منتج عسل سدر أصلي'));
console.log('Includes Product 2 Name:', html.includes('منتج زيت زيتون بكر'));
console.log('Includes Product 1 Pickup Photo:', html.includes('https://cloudinary.com/product1_pickup.jpg'));
console.log('Includes Product 1 Delivery Photo:', html.includes('https://cloudinary.com/product1_delivery.jpg'));
console.log('Includes Product 2 Pickup Photo:', html.includes('https://cloudinary.com/product2_pickup.jpg'));
console.log('Includes Product 2 Delivery Photo:', html.includes('https://cloudinary.com/product2_delivery.jpg'));
