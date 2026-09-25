const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dvhjawii0',
    api_key:    process.env.CLOUDINARY_API_KEY || '669711865811929',
    api_secret: process.env.CLOUDINARY_API_SECRET || 'BrOdv7wmIomLBptmZVjnTAc_qJY',
});

module.exports = cloudinary;

