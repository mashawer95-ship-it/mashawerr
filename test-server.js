const express = require('express');
const app = express();
const multer = require('multer');

const _multerUpload = multer().single('image');

function uploadProductImage(req, res, next) {
    _multerUpload(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({ message: 'Unexpected field. Use form field name: image' });
        }
        return next(err);
    });
}

app.post('/test', uploadProductImage, (req, res) => {
    res.json({ ok: true });
});

app.listen(3001, () => console.log('listening'));
