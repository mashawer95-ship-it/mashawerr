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
        const googleMapsKey =
            process.env.GOOGLE_MAPS_KEY ||
            process.env.GOOGLE_API_KEY ||
            process.env.GOOGLE_MAP_API_KEY ||
            '';

        res.status(200).json({
            success: true,
            config: {
                googleMapsKey,
            },
        });
    } catch (err) {
        logger.error(`[ConfigRoute] Error fetching client keys: ${err.message}`);
        res.status(500).json({ success: false, message: 'Failed to retrieve configuration' });
    }
});

module.exports = router;
