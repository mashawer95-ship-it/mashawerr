const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const ALLOWED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

const vehicleTypeStorage = new CloudinaryStorage({
    cloudinary,
    params: {
        folder: 'mashawerr/vehicletypes',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
        public_id: (req, file) => `vt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    },
});

const fileFilter = (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP allowed.'), false);
};

const uploadVehicleTypeImage = multer({
    storage: vehicleTypeStorage,
    fileFilter,
    limits: { fileSize: MAX_SIZE },
}).single('image');

module.exports = { uploadVehicleTypeImage };
