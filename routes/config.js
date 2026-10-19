/**
 * routes/config.js
 * Dynamic Client Configuration Endpoint
 *
 * Provides safe public/client keys (such as Google Maps Key) from
 * server environment variables so that keys don't have to be baked
 * permanently into mobile APK binaries.
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

// GET /api/config/client-keys
router.get('/client-keys', (req, res) => {
    try {
        // Only expose a key specifically designated for the mobile SDK (restricted by Package + SHA-1).
        // The master GOOGLE_MAPS_KEY stays secret on the server for /api/maps and /api/trip routes.
        const googleMapsKey =
            process.env.GOOGLE_MAPS_CLIENT_KEY ||
            process.env.GOOGLE_MAPS_ANDROID_KEY ||
            '';

        const paymobConfig = require('../payments/config/paymobConfig');
        const paymobPublicKey = paymobConfig.publicKey || '';

        res.status(200).json({
            success: true,
            config: {
                googleMapsKey,
                paymobPublicKey,
            },
        });
    } catch (err) {
        logger.error(`[ConfigRoute] Error fetching client keys: ${err.message}`);
        res.status(500).json({ success: false, message: 'Failed to retrieve configuration' });
    }
});

module.exports = router;
