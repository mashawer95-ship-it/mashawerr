const cloudinary = require('cloudinary').v2;

// SECURITY: credentials must come from the environment only (never hardcode fallbacks —
// anything committed to git must be treated as leaked and rotated).
const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    const msg = '[Cloudinary] CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are not set – image uploads will fail.';
    if (process.env.NODE_ENV === 'production') {
        console.error(msg);
    } else {
        console.warn(msg);
    }
}

cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key:    CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
});

module.exports = cloudinary;
