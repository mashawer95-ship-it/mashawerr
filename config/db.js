const mongoose = require('mongoose');
const logger = require('../utils/logger');

async function connectToDB() {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error('❌ MONGO_URI is not set in environment variables');
        console.error('   → Go to Render dashboard → Environment → Add MONGO_URI');
        return;
    }
    try {
        await mongoose.connect(uri, {
            serverSelectionTimeoutMS: 30000,
            connectTimeoutMS: 30000,
            socketTimeoutMS: 45000,
            heartbeatFrequencyMS: 10000,
            bufferCommands: true,
            bufferTimeoutMS: 20000,
            retryWrites: true,
            retryReads: true,
        });
        logger.info('MONGODB_CONNECTED');
        try {
            const { migrateOrderStatusFromNumbersToStrings, migrateUnifiedOrderIds } = require('../middlewares/Order');
            await migrateOrderStatusFromNumbersToStrings();
            await migrateUnifiedOrderIds();
        } catch (migrationErr) {
            console.warn('⚠️  Order migration skipped:', migrationErr.message);
        }

    } catch (err) {
        console.error('❌ Could not connect to MongoDB:', err.message);
        setTimeout(() => connectToDB(), 5000);
    }
}

// Auto-reconnect whenever mongoose loses the connection
mongoose.connection.on('disconnected', () => {
    logger.warn('MONGODB_DISCONNECTED', { reason: 'connection lost' });
    setTimeout(() => connectToDB(), 3000);
});

mongoose.connection.on('error', (err) => {
    console.error('❌ MongoDB error:', err.message);
});

/** Returns true if mongoose is currently connected or in TEST_MODE */
function isDbReady() {
    if (process.env.TEST_MODE === 'true' || process.env.NODE_ENV === 'test') return true;
    return mongoose.connection.readyState === 1;
}

module.exports = { connectToDB, isDbReady };
