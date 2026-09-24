const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function run() {
    try {
        const uri = process.env.MONGO_URI || process.env.DB_URL || process.env.MONGODB_URI;
        console.log('Connecting to:', uri ? uri.substring(0, 30) + '...' : 'undefined');
        await mongoose.connect(uri);
        console.log('Connected to MongoDB');
        
        const collection = mongoose.connection.collection('storeorders');
        
        // List all indexes
        const indexes = await collection.indexes();
        console.log('Current indexes:', JSON.stringify(indexes, null, 2));
        
        // Drop the unique index on storeOrderId if it exists
        const hasUniqueIndex = indexes.some(idx => idx.key && idx.key.storeOrderId !== undefined);
        if (hasUniqueIndex) {
            try {
                await collection.dropIndex('storeOrderId_1');
                console.log('✅ Unique index on storeOrderId dropped successfully');
            } catch (e) {
                console.log('Could not drop storeOrderId_1:', e.message);
            }
        } else {
            console.log('ℹ️ No storeOrderId index found');
        }
        
        // Re-list indexes
        const newIndexes = await collection.indexes();
        console.log('Indexes after:', JSON.stringify(newIndexes.map(i => ({ name: i.name, key: i.key })), null, 2));
        
        process.exit(0);
    } catch (e) {
        console.error('Error:', e.message);
        process.exit(1);
    }
}
run();
