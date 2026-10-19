const cloudinary = require('cloudinary').v2;

// NOTE: Render production historically relied on these fallback credentials (the
// CLOUDINARY_* env vars were never set there). Removing them broke POD/chat/profile uploads,
// so they are restored TEMPORARILY.
// TODO(security): set CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET in the
// Render dashboard, rotate the Cloudinary API secret (it is in git history), then delete the
// fallbacks below.
const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0';
const apiKey    = process.env.CLOUDINARY_API_KEY    || '669711865811929';
const apiSecret = process.env.CLOUDINARY_API_SECRET || 'BrOdv7wmIomLBptmZVjnTAc_qJY';

if (!process.env.CLOUDINARY_API_SECRET) {
    console.warn('[Cloudinary] CLOUDINARY_API_SECRET env var not set – using legacy fallback credentials. Set it on Render and rotate the key.');
}

cloudinary.config({
    cloud_name: cloudName,
    api_key:    apiKey,
    api_secret: apiSecret,
});

module.exports = cloudinary;
