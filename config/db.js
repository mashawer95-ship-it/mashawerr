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
            // Pool: size per instance. Total = instances x maxPoolSize must stay below the Atlas tier limit.
            maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 50,
            minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 5,
            maxIdleTimeMS: 60000,
            serverSelectionTimeoutMS: 15000,
            connectTimeoutMS: 15000,
            socketTimeoutMS: 45000,
            heartbeatFrequencyMS: 10000,
            bufferCommands: true,
            bufferTimeoutMS: 10000,
            retryWrites: true,
            retryReads: true,
        });
        logger.info('MONGODB_CONNECTED');
        const runMigrations = process.env.RUN_STARTUP_MIGRATIONS !== 'false';
        let gotLock = false;
        if (runMigrations) {
            const { redisLock } = require('./redis');
            gotLock = await redisLock('startup_migrations', 5 * 60 * 1000);
            if (!gotLock) logger.info('[DB] Startup migrations already running on another instance – skipping');
        }
        if (runMigrations && gotLock) try {
            const { migrateOrderStatusFromNumbersToStrings, migrateUnifiedOrderIds } = require('../middlewares/Order');
            await migrateOrderStatusFromNumbersToStrings();
            await migrateUnifiedOrderIds();
            const { autoFixVehicleCategories } = require('../middlewares/VehicleType');
            if (autoFixVehicleCategories) await autoFixVehicleCategories();
            const { fixPaymentIndexes } = require('../middlewares/Payment');
            if (fixPaymentIndexes) await fixPaymentIndexes();
            const { fixOrderIdempotencyIndexes } = require('../middlewares/Order');
            if (fixOrderIdempotencyIndexes) await fixOrderIdempotencyIndexes();
            const { fixGoogleIdIndex } = require('../middlewares/User');
            if (fixGoogleIdIndex) await fixGoogleIdIndex();
        } catch (migrationErr) {
            console.warn('⚠️  Migration/Index fix skipped:', migrationErr.message);
        }

    } catch (err) {
        console.error('❌ Could not connect to MongoDB:', err.message);
        setTimeout(() => connectToDB(), 5000);
    }
}

// The MongoDB driver reconnects automatically after a drop; calling connect() again here
// would open duplicate connections and re-run startup migrations. Just log.
mongoose.connection.on('disconnected', () => {
    logger.warn('MONGODB_DISCONNECTED', { reason: 'connection lost (driver will auto-reconnect)' });
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
