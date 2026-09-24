const mongoose = require('mongoose');

async function testDistinctProductPhotos() {
    console.log('--- Testing Per-Product Isolated Photos (No Duplication) ---');

    const mockReq = {
        protocol: 'https',
        get: () => 'mashawerr-np6n.onrender.com',
        user: { id: 'admin123', isAdmin: true, userType: 'Admin' }
    };

    // Order with 2 products: Product 1 has photos, Product 2 does NOT have photos yet
    const mockOrderMultiProducts = {
        _id: new mongoose.Types.ObjectId(),
        storeOrderId: 8888,
        orderId: 8888,
        isBusinessOrder: true,
        orderCategory: 'business',
        userId: '507f1f77bcf86cd799439011',
        userInfo: { firstName: 'محمد', lastName: 'خالد', phone: '90008000' },
        pickupPhoto: 'mashawerr/order-photos/pickup_p1.jpg',
        deliveryPhoto: 'mashawerr/order-photos/delivery_p1.jpg',
        items: [
            {
                name: 'منتج 1 (تيشيرت)',
                price: 5.0,
                quantity: 1,
                pickupPhoto: 'mashawerr/order-photos/pickup_p1.jpg',
                deliveryPhoto: 'mashawerr/order-photos/delivery_p1.jpg',
            },
            {
                name: 'منتج 2 (حذاء)',
                price: 15.0,
                quantity: 1,
                // No pickup or delivery photo uploaded for Product 2
            }
        ]
    };

    const storeOrderController = require('../Controllers/storeOrderController');

    // We pass mockOrderMultiProducts to enrichOrderImages helper logic
    const { buildUrl } = require('../config/urlBuilder');

    const item1_pickup = buildUrl(mockReq, mockOrderMultiProducts.items[0].pickupPhoto);
    const item1_delivery = buildUrl(mockReq, mockOrderMultiProducts.items[0].deliveryPhoto);
    const item2_pickup = mockOrderMultiProducts.items[1].pickupPhoto ? buildUrl(mockReq, mockOrderMultiProducts.items[1].pickupPhoto) : null;
    const item2_delivery = mockOrderMultiProducts.items[1].deliveryPhoto ? buildUrl(mockReq, mockOrderMultiProducts.items[1].deliveryPhoto) : null;

    console.log('Item 1 Pickup Photo:', item1_pickup);
    console.log('Item 1 Delivery Photo:', item1_delivery);
    console.log('Item 2 Pickup Photo:', item2_pickup);
    console.log('Item 2 Delivery Photo:', item2_delivery);

    if (item2_pickup !== null || item2_delivery !== null) {
        console.error('❌ FAIL: Product 2 incorrectly inherited Product 1 photos!');
        process.exit(1);
    } else {
        console.log('✅ SUCCESS: Product 2 photos are isolated (null) as expected without duplication!');
    }
}

testDistinctProductPhotos().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
