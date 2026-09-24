const express = require('express');
const router = express.Router();

const {
    createAssociation,
    getAllAssociations,
    getAssociationById,
    updateAssociation,
    deleteAssociation,
    getAssociationProducts,
    setAssociationLocation,
} = require('../Controllers/associationController');

const { verifyToken } = require('../middlewares/verifytoken');
const { adminOnly } = require('../middlewares/authorize');
const { uploadAssociationLogo } = require('../middlewares/uploadAssociation');

// ─── Public-ish (token required, any authenticated role) ─────────────────────
router.get('/', verifyToken, getAllAssociations);
router.get('/:id', verifyToken, getAssociationById);
router.get('/:id/products', verifyToken, getAssociationProducts);

// ─── Admin only ───────────────────────────────────────────────────────────────
router.post('/', adminOnly, uploadAssociationLogo, createAssociation);
router.put('/:id', adminOnly, uploadAssociationLogo, updateAssociation);
router.delete('/:id', adminOnly, deleteAssociation);

// Admin sets the pickup location for the association (where rep picks up from)
router.patch('/:id/location', adminOnly, setAssociationLocation);

module.exports = router;
