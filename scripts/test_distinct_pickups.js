const { getBusinessOrderCompletionEmailHtml } = require('../services/emailService');

const mockDistinctPickupOrder = {
    storeOrderId: 888,
    parentGroupId: 'uuid-group-distinct-pickups',
    isBusinessOrder: true,
    subOrders: [
        {
            _id: 'sub_1',
            storeOrderId: 888,
            pickupPhoto: 'https://cloudinary.com/pickup_product_1.jpg',
            deliveryPhoto: 'https://cloudinary.com/delivery_product_1.jpg',
            items: [
                {
                    name: 'منتج السدر الأول',
                    quantity: 1,
                    price: 12.000,
                    subtotal: 12.000,
                    pickupPhoto: 'https://cloudinary.com/pickup_product_1.jpg',
                    deliveryPhoto: 'https://cloudinary.com/delivery_product_1.jpg'
                }
            ]
        },
        {
            _id: 'sub_2',
            storeOrderId: 889,
            pickupPhoto: 'https://cloudinary.com/pickup_product_2.jpg',
            deliveryPhoto: 'https://cloudinary.com/delivery_product_2.jpg',
            items: [
                {
                    name: 'منتج الزيتون الثاني',
                    quantity: 1,
                    price: 15.000,
                    subtotal: 15.000,
                    pickupPhoto: 'https://cloudinary.com/pickup_product_2.jpg',
                    deliveryPhoto: 'https://cloudinary.com/delivery_product_2.jpg'
                }
            ]
        }
    ]
};

const html = getBusinessOrderCompletionEmailHtml(mockDistinctPickupOrder, { firstName: 'خالد' });

console.log('--- Distinct Pickup Photos Email Test ---');
console.log('Includes Product 1 Pickup Photo:', html.includes('https://cloudinary.com/pickup_product_1.jpg'));
console.log('Includes Product 1 Delivery Photo:', html.includes('https://cloudinary.com/delivery_product_1.jpg'));
console.log('Includes Product 2 Pickup Photo:', html.includes('https://cloudinary.com/pickup_product_2.jpg'));
console.log('Includes Product 2 Delivery Photo:', html.includes('https://cloudinary.com/delivery_product_2.jpg'));
