const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const ALLOWED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

// ─── Cloudinary Storage ───────────────────────────────────────────────────────
const productStorage = new CloudinaryStorage({
    cloudinary,
    params: {
        folder: 'mashawerr/products',          // Cloudinary folder
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
        public_id: (req, file) =>
            `product-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
});

const productFileFilter = (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP allowed.'), false);
};

// Accepts up to 10 images in the field name "images"
const uploadProductImages = multer({
    storage: productStorage,
    fileFilter: productFileFilter,
    limits: { fileSize: MAX_SIZE },
}).array('images', 10);

module.exports = { uploadProductImages };
