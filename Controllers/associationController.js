const cloudinary = require('../config/cloudinary');
const { Association, validateCreateAssociation, validateUpdateAssociation, validateSetAssociationLocation } = require('../middlewares/Association');
const { Product } = require('../middlewares/Product');
const { Favorite } = require('../middlewares/Favorite');
const { buildUrl } = require('../config/urlBuilder');
const path = require('path');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatAssociation(assoc) {
    const obj = assoc.toObject ? assoc.toObject() : { ...assoc };
    return obj;
}

function buildImageUrl(req, filename) {
    if (!filename) return null;
    if (filename.startsWith('http://') || filename.startsWith('https://')) return filename;
    return buildUrl(req, `products/${path.basename(filename)}`);
}

function formatProduct(product, req) {
    const obj = product.toObject ? product.toObject() : { ...product };

    let rawImages = [];
    if (Array.isArray(obj.images) && obj.images.length > 0) {
        rawImages = obj.images;
    } else if (obj.image && typeof obj.image === 'string' && obj.image.trim() !== '') {
        rawImages = [obj.image];
    }
    obj.images = rawImages
        .filter(f => f && f.trim() !== '')
        .map(f => buildImageUrl(req, f));
    delete obj.image;
    return obj;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * @desc   Create a new association (admin only)
 * @route  POST /api/store/associations
 */
const createAssociation = async (req, res) => {
    const { error, value } = validateCreateAssociation(req.body);
    if (error) return res.status(400).json({ message: error.details.map(d => d.message).join(', ') });

    const association = new Association(value);

    // multer-storage-cloudinary sets file.path = full Cloudinary URL
    if (req.file) {
        association.logo = req.file.path;
    }

    await association.save();

    res.status(201).json({
        message: 'Association created successfully',
        association: formatAssociation(association),
    });
};

/**
 * @desc   Get all associations (admin sees all; clients see active only)
 * @route  GET /api/store/associations
 */
const getAllAssociations = async (req, res) => {
    const isAdmin = req.user?.isAdmin;
    const { search } = req.query;

    const filter = {};
    if (!isAdmin) {
        filter.isActive = true;
    }

    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
        ];
    }

    const associations = await Association.find(filter).sort({ createdAt: -1 });

    // Attach product count per association
    const ids = associations.map(a => a._id);
    const productCounts = await Product.aggregate([
        { $match: { associationId: { $in: ids }, isActive: true } },
        { $group: { _id: '$associationId', count: { $sum: 1 } } },
    ]);
    const countMap = {};
    productCounts.forEach(pc => { countMap[pc._id.toString()] = pc.count; });

    const result = associations.map(a => {
        const obj = formatAssociation(a);
        obj.productCount = countMap[a._id.toString()] || 0;
        return obj;
    });

    res.json({ total: result.length, associations: result });
};

/**
 * @desc   Get single association by ID
 * @route  GET /api/store/associations/:id
 */
const getAssociationById = async (req, res) => {
    const association = await Association.findById(req.params.id);
    if (!association) return res.status(404).json({ message: 'Association not found' });

    const isAdmin = req.user?.isAdmin;
    if (!isAdmin && !association.isActive) {
        return res.status(404).json({ message: 'Association not found' });
    }

    const productCount = await Product.countDocuments({
        associationId: association._id,
        isActive: true,
    });

    const obj = formatAssociation(association);
    obj.productCount = productCount;

    res.json(obj);
};

/**
 * @desc   Update association (admin only)
 * @route  PUT /api/store/associations/:id
 */
const updateAssociation = async (req, res) => {
    const { error, value } = validateUpdateAssociation(req.body);
    if (error) return res.status(400).json({ message: error.details.map(d => d.message).join(', ') });

    const association = await Association.findById(req.params.id);
    if (!association) return res.status(404).json({ message: 'Association not found' });

    // Handle logo replacement
    if (req.file) {
        // Delete old logo from Cloudinary (best-effort)
        if (association.logo) {
            const parts = association.logo.split('/');
            const filenameWithExt = parts[parts.length - 1];
            const filename = filenameWithExt.replace(/\.[^.]+$/, '');
            const folder = parts[parts.length - 2];
            const publicId = `${folder}/${filename}`;
            await cloudinary.uploader.destroy(publicId).catch(() => {});
        }
        value.logo = req.file.path;
    }

    Object.assign(association, value);
    await association.save();

    res.json({
        message: 'Association updated successfully',
        association: formatAssociation(association),
    });
};

/**
 * @desc   Delete association (admin only)
 * @route  DELETE /api/store/associations/:id
 */
const deleteAssociation = async (req, res) => {
    const association = await Association.findById(req.params.id);
    if (!association) return res.status(404).json({ message: 'Association not found' });

    // Unlink all products from this association
    await Product.updateMany(
        { associationId: association._id },
        { $set: { associationId: null } }
    );

    // Delete logo from Cloudinary (best-effort)
    if (association.logo) {
        const parts = association.logo.split('/');
        const filenameWithExt = parts[parts.length - 1];
        const filename = filenameWithExt.replace(/\.[^.]+$/, '');
        const folder = parts[parts.length - 2];
        const publicId = `${folder}/${filename}`;
        await cloudinary.uploader.destroy(publicId).catch(() => {});
    }

    await association.deleteOne();

    res.json({ message: 'Association deleted successfully' });
};

/**
 * @desc   Get all products belonging to a specific association
 * @route  GET /api/store/associations/:id/products
 */
const getAssociationProducts = async (req, res) => {
    const { page = 1, limit = 20, search, isSoldOut } = req.query;

    const association = await Association.findById(req.params.id);
    if (!association) return res.status(404).json({ message: 'Association not found' });

    const isAdmin = req.user?.isAdmin;
    const isAgent = req.user?.userType === 'Agent';
    const isAdminOrAgent = isAdmin || isAgent;
    const userId = req.user?.id;

    if (!isAdmin && !association.isActive) {
        return res.status(404).json({ message: 'Association not found' });
    }

    const filter = { associationId: association._id };

    // Clients only see active products
    if (!isAdminOrAgent) {
        filter.isActive = true;
    }

    if (search) {
        filter.$or = [
            { name: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
            { category: { $regex: search, $options: 'i' } },
        ];
    }

    if (isSoldOut !== undefined) {
        filter.isSoldOut = isSoldOut === 'true';
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [products, total] = await Promise.all([
        Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
        Product.countDocuments(filter),
    ]);

    // Batch favorited check
    const favoriteIds = new Set();
    if (userId) {
        const favs = await Favorite.find(
            { userId, productId: { $in: products.map(p => p._id) } },
            { productId: 1 }
        );
        favs.forEach(f => favoriteIds.add(f.productId.toString()));
    }

    res.json({
        association: formatAssociation(association),
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
        products: products.map(p => {
            const formatted = formatProduct(p, req);
            formatted.isFavorited = favoriteIds.has(p._id.toString());
            return formatted;
        }),
    });
};

/**
 * @desc   Set / update pickup location for an association (admin only)
 * @route  PATCH /api/store/associations/:id/location
 * @body   { lat: Number, lng: Number, address?: String }
 */
const setAssociationLocation = async (req, res) => {
    const { error, value } = validateSetAssociationLocation(req.body);
    if (error) return res.status(400).json({ message: error.details.map(d => d.message).join(', ') });

    const association = await Association.findById(req.params.id);
    if (!association) return res.status(404).json({ message: 'Association not found' });

    association.pickupLocation = {
        lat:     value.lat,
        lng:     value.lng,
        address: value.address || '',
    };
    await association.save();

    res.json({
        message: 'Pickup location updated successfully',
        associationId: association._id,
        name: association.name,
        pickupLocation: association.pickupLocation,
    });
};

module.exports = {
    createAssociation,
    getAllAssociations,
    getAssociationById,
    updateAssociation,
    deleteAssociation,
    getAssociationProducts,
    setAssociationLocation,
};
