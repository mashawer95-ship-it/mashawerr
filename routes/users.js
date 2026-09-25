const express = require('express');
const router = express.Router();
const { updateUser, getAllUser, getProfile, getUserbyid, uploadProfileImageHandler, DeleteUserbyid, toggleRepresentativeAvailability, setUserAsRepresentative, migrateRepresentatives, updateVehicleInfo, clearStaleImages, updateOnlineLocation, getOnlineRepresentatives, suspendUser, unsuspendUser, getSuspendedUsers, blockUser, unblockUser, getRepresentativeOrders, getRepresentativeRatingsAdmin, toggleVehicleEditPermission, changeUserType, getBannedDevices, unbanBannedDevice } = require('../Controllers/userController');
const { uploadProfileImage, uploadVehicleImage } = require('../middlewares/upload');
const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');
const { authorize } = require('../middlewares/authorize');
const { createRoleRequest, getAllRoleRequests, updateRoleRequestStatus } = require('../Controllers/roleRequestController');

router.get('/', verifyToken, authorize('admin', 'administration'), getAllUser);
router.get('/profile/:id', verifyToken, getProfile);

// 📝 Change User Type / Role (Admin only)
router.patch('/:id/change-user-type', verifyTokenAndAdmin, changeUserType);

// 📝 Role Requests (Representative)
router.post('/request-role', verifyToken, createRoleRequest);
router.get('/role-requests', verifyTokenAndAdmin, getAllRoleRequests);
router.patch('/role-requests/:id/status', verifyTokenAndAdmin, updateRoleRequestStatus);

// 🚫 Account Suspension & Blocking (Admin only)
router.get('/suspended', verifyTokenAndAdmin, getSuspendedUsers);
router.patch('/suspend/:id', verifyTokenAndAdmin, suspendUser);
router.patch('/:id/suspend', verifyTokenAndAdmin, suspendUser);
router.put('/:id/suspend', verifyTokenAndAdmin, suspendUser);

router.patch('/unsuspend/:id', verifyTokenAndAdmin, unsuspendUser);
router.patch('/:id/unsuspend', verifyTokenAndAdmin, unsuspendUser);
router.put('/:id/unsuspend', verifyTokenAndAdmin, unsuspendUser);

router.put('/:id/block', verifyTokenAndAdmin, blockUser);
router.patch('/:id/block', verifyTokenAndAdmin, blockUser);

router.put('/:id/unblock', verifyTokenAndAdmin, unblockUser);
router.patch('/:id/unblock', verifyTokenAndAdmin, unblockUser);

// 🚫 Banned Devices & Identifiers (Admin only)
router.get('/banned-devices', verifyTokenAndAdmin, getBannedDevices);
router.delete('/banned-devices/:id', verifyTokenAndAdmin, unbanBannedDevice);

// 🚗 Admin: Toggle or set representative vehicle edit permissions (Lock/Unlock)
router.patch('/:id/vehicle-edit-permissions', verifyTokenAndAdmin, toggleVehicleEditPermission);
router.patch('/:id/toggle-vehicle-edit', verifyTokenAndAdmin, toggleVehicleEditPermission);

// 🚗 Live map tracking: Get all online available representatives (MUST be before /:id)
router.get('/online-representatives/locations', verifyToken, getOnlineRepresentatives);

router.get('/:id', verifyToken, getUserbyid);
router.put('/:id/profile-image', verifyToken, uploadProfileImage, uploadProfileImageHandler);
router.put('/:id', verifyToken, updateUser);
// DELETE /api/users/:id - Hard delete user account and all related orders & data (Admin only)
router.delete('/:id', verifyTokenAndAdmin, DeleteUserbyid);

// Toggle availability
router.patch('/:id/availability', verifyToken, toggleRepresentativeAvailability);

// Promote single user to Representative (Admin only)
router.patch('/:id/set-representative', verifyTokenAndAdmin, setUserAsRepresentative);

// Vehicle info (representative) — PATCH /api/users/:id/vehicle
router.patch('/:id/vehicle', verifyToken, uploadVehicleImage, updateVehicleInfo);

// ⚡ One-time migration: promote existing representatives in DB (Admin only)
// POST /api/users/migrate-representatives  body: { ids: [...] } or empty body
router.post('/migrate-representatives', verifyTokenAndAdmin, migrateRepresentatives);

// 🧹 One-time cleanup: clear stale Render-local image URLs from DB (Admin only)
// POST /api/users/clear-stale-images
router.post('/clear-stale-images', verifyTokenAndAdmin, clearStaleImages);

// 🚗 Live map tracking: Update representative's location
router.patch('/:id/online-location', verifyToken, updateOnlineLocation);

// 📦 Admin & Administration: Get orders delivered by a representative (filterable by month/year)
router.get('/:id/representative-orders', verifyToken, authorize('admin', 'administration'), getRepresentativeOrders);

// ⭐ Admin & Administration: Get ratings received by / given by a representative
router.get('/:id/representative-ratings', verifyToken, authorize('admin', 'administration'), getRepresentativeRatingsAdmin);

// Routes moved to top to prevent /:id override

module.exports = router;

