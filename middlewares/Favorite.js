const mongoose = require('mongoose');

// ─── Favorite Schema ──────────────────────────────────────────────────────────
const FavoriteSchema = new mongoose.Schema(
    {
        userId: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Product',
            required: true,
        },
    },
    { timestamps: true }
);

// One favorite entry per user per product
FavoriteSchema.index({ userId: 1, productId: 1 }, { unique: true });

const Favorite = mongoose.model('Favorite', FavoriteSchema);

module.exports = { Favorite };
