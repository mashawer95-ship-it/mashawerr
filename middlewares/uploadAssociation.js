const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const ALLOWED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

// ─── Cloudinary Storage ───────────────────────────────────────────────────────
const associationStorage = new CloudinaryStorage({
    cloudinary,
    params: {
        folder: 'mashawerr/associations',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
        public_id: (_req, _file) =>
            `association-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
});

const associationFileFilter = (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP allowed.'), false);
};

// Accepts ONE logo image in the field name "logo"
const uploadAssociationLogo = multer({
    storage: associationStorage,
    fileFilter: associationFileFilter,
    limits: { fileSize: MAX_SIZE },
}).single('logo');

module.exports = { uploadAssociationLogo };
