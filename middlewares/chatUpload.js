const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

const MAX_SIZE = 20 * 1024 * 1024; // 20MB

const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_AUDIO_MIMES = [
    'audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/mp3', 'audio/aac', 
    'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/opus', 
    'audio/x-m4a', 'audio/amr', 'audio/3gpp'
];

const ALLOWED_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp',
    '.m4a', '.mp3', '.aac', '.wav', '.ogg', '.opus', '.weba', '.amr'
]);

const chatFileFilter = (req, file, cb) => {
    if (ALLOWED_IMAGE_MIMES.includes(file.mimetype) || ALLOWED_AUDIO_MIMES.includes(file.mimetype)) {
        return cb(null, true);
    }
    const ext = '.' + (file.originalname || '').split('.').pop().toLowerCase();
    if (ALLOWED_EXT.has(ext)) {
        return cb(null, true);
    }
    cb(new Error('Invalid file type. Supported: JPG, PNG, WebP, GIF, M4A, MP3, AAC, WAV, OGG, OPUS.'), false);
};

// ─── Cloudinary Storage for Chat Media ───────────────────────────────────────
const chatStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => {
        const isAudio = file.mimetype.startsWith('audio') || 
            /\.(m4a|mp3|aac|wav|ogg|opus|amr)$/i.test(file.originalname || '');
        return {
            folder: 'mashawerr/chat',
            resource_type: 'auto', // Handles images, videos, audio automatically
            public_id: `chat-${isAudio ? 'voice' : 'img'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        };
    },
});

const uploadChatMedia = multer({
    storage: chatStorage,
    fileFilter: chatFileFilter,
    limits: { fileSize: MAX_SIZE },
}).single('file');

module.exports = { uploadChatMedia };
