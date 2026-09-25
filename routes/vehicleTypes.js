const express = require('express');
const router = express.Router();
const {
    createVehicleType,
    updateVehicleType,
    getVehicleTypes,
    deleteVehicleType,
    calculateVehiclePrices,
} = require('../Controllers/vehicleTypeController');
const { verifyTokenAndAdmin } = require('../middlewares/verifytoken');
const { uploadVehicleTypeImage } = require('../middlewares/uploadVehicleTypeImage');

/**
 * @swagger
 * tags:
 *   name: Vehicle Types
 *   description: Vehicle types and pricing management
 */

/**
 * @swagger
 * /api/vehicle-types:
 *   get:
 *     summary: Get all vehicle types
 *     tags: [Vehicle Types]
 *     parameters:
 *       - in: query
 *         name: active
 *         schema:
 *           type: string
 *         description: Set to "true" to get only active vehicle types
 *     responses:
 *       200:
 *         description: List of vehicle types
 */
router.get('/', getVehicleTypes);

/**
 * @swagger
 * /api/vehicle-types:
 *   post:
 *     summary: Create a new vehicle type (Admin only)
 *     tags: [Vehicle Types]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - name_ar
 *             properties:
 *               name_ar:
 *                 type: string
 *               name_en:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *               baseFare:
 *                 type: number
 *                 description: Base fare in Egyptian Pounds (EGP / ج.م)
 *               pricePerMeter:
 *                 type: number
 *                 description: Price per meter in Egyptian Pounds (EGP / ج.م)
 *               minFare:
 *                 type: number
 *                 description: Minimum fare in Egyptian Pounds (EGP / ج.م)
 *               surgeMultiplier:
 *                 type: number
 *                 description: Surge multiplier
 *               isActive:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Vehicle type created successfully
 */
router.post('/', verifyTokenAndAdmin, uploadVehicleTypeImage, createVehicleType);

/**
 * @swagger
 * /api/vehicle-types/{id}:
 *   put:
 *     summary: Update a vehicle type (Admin only)
 *     tags: [Vehicle Types]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name_ar:
 *                 type: string
 *               name_en:
 *                 type: string
 *               image:
 *                 type: string
 *                 format: binary
 *               baseFare:
 *                 type: number
 *               pricePerMeter:
 *                 type: number
 *               minFare:
 *                 type: number
 *               surgeMultiplier:
 *                 type: number
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Vehicle type updated successfully
 */
router.put('/:id', verifyTokenAndAdmin, uploadVehicleTypeImage, updateVehicleType);

/**
 * @swagger
 * /api/vehicle-types/{id}:
 *   delete:
 *     summary: Delete a vehicle type (Admin only)
 *     tags: [Vehicle Types]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Vehicle type deleted successfully
 */
router.delete('/:id', verifyTokenAndAdmin, deleteVehicleType);

/**
 * @swagger
 * /api/vehicle-types/calculate-price:
 *   post:
 *     summary: Calculate prices for all active vehicle types based on distance
 *     tags: [Vehicle Types]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - distance_meters
 *             properties:
 *               distance_meters:
 *                 type: number
 *     responses:
 *       200:
 *         description: List of vehicle types with calculated prices
 */
router.post('/calculate-price', calculateVehiclePrices);

module.exports = router;
