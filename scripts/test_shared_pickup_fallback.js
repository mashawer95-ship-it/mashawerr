const { getBusinessOrderCompletionEmailHtml } = require('../services/emailService');

// Scenario: Driver takes 1 pickup photo for both products (shared pickup location),
// and separate delivery photos for product 1 and product 2.
const mockSharedPickupBusinessOrder = {
    storeOrderId: 666,
    parentGroupId: 'uuid-group-shared-pickup',
    isBusinessOrder: true,
    pickupPhoto: 'https://cloudinary.com/shared_group_pickup.jpg',
    subOrders: [
        {
            _id: 'sub_1',
            storeOrderId: 666,
            pickupPhoto: 'https://cloudinary.com/shared_group_pickup.jpg',
            deliveryPhoto: 'https://cloudinary.com/product1_delivery.jpg',
            items: [
                {
                    name: 'منتج أ',
                    quantity: 1,
                    price: 10.000,
                    subtotal: 10.000,
                }
            ]
        },
        {
            _id: 'sub_2',
            storeOrderId: 667,
            pickupPhoto: null, // Driver did not take separate pickup photo because both picked up together!
            deliveryPhoto: 'https://cloudinary.com/product2_delivery.jpg',
            items: [
                {
                    name: 'منتج ب',
                    quantity: 1,
                    price: 20.000,
                    subtotal: 20.000,
                }
            ]
        }
    ]
};

const html = getBusinessOrderCompletionEmailHtml(mockSharedPickupBusinessOrder, { firstName: 'محمد' });

console.log('--- Shared Pickup Fallback Email Test ---');
console.log('Includes Product A Name:', html.includes('منتج أ'));
console.log('Includes Product B Name:', html.includes('منتج ب'));
console.log('Product A Delivery Photo:', html.includes('https://cloudinary.com/product1_delivery.jpg'));
console.log('Product B Delivery Photo:', html.includes('https://cloudinary.com/product2_delivery.jpg'));
console.log('Product B inherited Shared Pickup Photo:', html.includes('https://cloudinary.com/shared_group_pickup.jpg'));
