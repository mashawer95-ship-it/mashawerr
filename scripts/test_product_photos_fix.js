const mongoose = require('mongoose');
const { StoreOrder } = require('../middlewares/StoreOrder');
const { enrichOrder } = require('../Controllers/storeOrderController');

async function testFix() {
    console.log('Testing StoreOrder per-product photo persistence & enrichment...');

    const sampleDoc = new StoreOrder({
        userId: 'user_123',
        totalPrice: 20,
        paymentMethod: 'cash',
        items: [
            {
                product: new mongoose.Types.ObjectId(),
                name: 'قميص قطني فاخر',
                price: 10,
                quantity: 1,
                subtotal: 10,
                pickupPhotoUrl: 'http://cdn.example.com/pickup_shirt.jpg',
                deliveryPhotoUrl: 'http://cdn.example.com/delivery_shirt.jpg',
                pickupPhoto: 'http://cdn.example.com/pickup_shirt.jpg',
                deliveryPhoto: 'http://cdn.example.com/delivery_shirt.jpg',
                itemPhotoBefore: 'http://cdn.example.com/pickup_shirt.jpg',
                itemPhotoAfter: 'http://cdn.example.com/delivery_shirt.jpg',
            },
            {
                product: new mongoose.Types.ObjectId(),
                name: 'حذاء رياضي',
                price: 10,
                quantity: 1,
                subtotal: 10,
                pickupPhotoUrl: 'http://cdn.example.com/pickup_shoes.jpg',
                deliveryPhotoUrl: 'http://cdn.example.com/delivery_shoes.jpg',
                pickupPhoto: 'http://cdn.example.com/pickup_shoes.jpg',
                deliveryPhoto: 'http://cdn.example.com/delivery_shoes.jpg',
                itemPhotoBefore: 'http://cdn.example.com/pickup_shoes.jpg',
                itemPhotoAfter: 'http://cdn.example.com/delivery_shoes.jpg',
            }
        ]
    });

    const plainObj = sampleDoc.toObject();

    console.log('\n--- MongoDB Document Serialization Check ---');
    console.log('Item 1 pickupPhotoUrl:', plainObj.items[0].pickupPhotoUrl);
    console.log('Item 1 deliveryPhotoUrl:', plainObj.items[0].deliveryPhotoUrl);
    console.log('Item 2 pickupPhotoUrl:', plainObj.items[1].pickupPhotoUrl);
    console.log('Item 2 deliveryPhotoUrl:', plainObj.items[1].deliveryPhotoUrl);

    if (
        plainObj.items[0].pickupPhotoUrl === 'http://cdn.example.com/pickup_shirt.jpg' &&
        plainObj.items[0].deliveryPhotoUrl === 'http://cdn.example.com/delivery_shirt.jpg' &&
        plainObj.items[1].pickupPhotoUrl === 'http://cdn.example.com/pickup_shoes.jpg' &&
        plainObj.items[1].deliveryPhotoUrl === 'http://cdn.example.com/delivery_shoes.jpg'
    ) {
        console.log('\n✅ SUCCESS: Mongoose Schema now correctly retains all 4 photo URLs across items!');
    } else {
        console.error('\n❌ FAILURE: Mongoose Schema stripped photo URLs from items!');
        process.exit(1);
    }

    const enriched = await enrichOrder(plainObj);
    console.log('\n--- Enriched API Output Check ---');
    console.log('Enriched Item 1 pickupPhotoUrl:', enriched.items[0].pickupPhotoUrl);
    console.log('Enriched Item 1 deliveryPhotoUrl:', enriched.items[0].deliveryPhotoUrl);
    console.log('Enriched Item 2 pickupPhotoUrl:', enriched.items[1].pickupPhotoUrl);
    console.log('Enriched Item 2 deliveryPhotoUrl:', enriched.items[1].deliveryPhotoUrl);

    if (
        enriched.items[0].pickupPhotoUrl === 'http://cdn.example.com/pickup_shirt.jpg' &&
        enriched.items[0].deliveryPhotoUrl === 'http://cdn.example.com/delivery_shirt.jpg' &&
        enriched.items[1].pickupPhotoUrl === 'http://cdn.example.com/pickup_shoes.jpg' &&
        enriched.items[1].deliveryPhotoUrl === 'http://cdn.example.com/delivery_shoes.jpg'
    ) {
        console.log('\n✅ ALL TESTS PASSED: Both products contain their distinct pickup and delivery photos!');
        process.exit(0);
    } else {
        console.error('\n❌ FAILURE in API enrichment!');
        process.exit(1);
    }
}

testFix().catch((e) => {
    console.error(e);
    process.exit(1);
});
