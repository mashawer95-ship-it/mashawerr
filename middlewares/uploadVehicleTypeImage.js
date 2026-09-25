const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const ALLOWED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

const vehicleTypeStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
        folder: 'mashawerr/vehicletypes',
        public_id: `vt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        resource_type: 'image',
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
    }),
});

const fileFilter = (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
        return cb(null, true);
    }
    const ext = (file.originalname || '').split('.').pop().toLowerCase();
    if (ALLOWED_EXT.has(`.${ext}`)) {
        return cb(null, true);
    }
    cb(new Error('نوع الملف غير صالح. يُسمح فقط بصور JPEG, PNG, GIF, WebP.'), false);
};

const upload = multer({
    storage: vehicleTypeStorage,
    fileFilter,
    limits: { fileSize: MAX_SIZE },
}).single('image');

const uploadVehicleTypeImage = (req, res, next) => {
    upload(req, res, (err) => {
        if (err) {
            console.error('Vehicle type image upload error:', err);
            const message = typeof err === 'string'
                ? err
                : (err.message || (err.error && err.error.message) || 'فشل في رفع صورة نوع المركبة');
            return res.status(400).json({
                success: false,
                message,
            });
        }
        next();
    });
};

module.exports = { uploadVehicleTypeImage };

