const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

const fileFilter = (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
        return cb(null, true);
    }
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    if (ALLOWED_EXT.has(`.${ext}`)) {
        return cb(null, true);
    }
    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP allowed.'), false);
};

// ─── Profile image → Cloudinary (mashawerr/profiles/) ───────────────────────────
const profileStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
        folder: 'mashawerr/profiles',
        public_id: `${req.params.id}-${Date.now()}`,
        overwrite: true,
        resource_type: 'image',
        // auto-format & quality for smaller file size
        transformation: [{ width: 400, height: 400, crop: 'fill', quality: 'auto', fetch_format: 'auto' }],
    }),
});

const uploadProfileImage = multer({
    storage: profileStorage,
    fileFilter,
    limits: { fileSize: MAX_SIZE },
}).single('image');

// ─── Vehicle image → Cloudinary (mashawerr/vehicles/) ───────────────────────────
const vehicleStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
        folder: 'mashawerr/vehicles',
        public_id: `vehicle-${req.params.id}-${Date.now()}`,
        overwrite: true,
        resource_type: 'image',
        transformation: [{ width: 800, quality: 'auto', fetch_format: 'auto' }],
    }),
});

const uploadVehicleImage = multer({
    storage: vehicleStorage,
    fileFilter,
    limits: { fileSize: MAX_SIZE },
}).single('vehicleImage');

module.exports = { uploadProfileImage, uploadVehicleImage };
