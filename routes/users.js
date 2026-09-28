const express = require('express');
const router = express.Router();
const { updateUser, getAllUser, getProfile, getUserbyid, uploadProfileImageHandler, DeleteUserbyid, toggleRepresentativeAvailability, setUserAsRepresentative, migrateRepresentatives, updateVehicleInfo, clearStaleImages, updateOnlineLocation, getOnlineRepresentatives, suspendUser, unsuspendUser, getSuspendedUsers, blockUser, unblockUser, getRepresentativeOrders, getRepresentativeRatingsAdmin, toggleVehicleEditPermission, changeUserType, getBannedDevices, unbanBannedDevice, updateUserGovernorate } = require('../Controllers/userController');
const { uploadProfileImage, uploadVehicleImage } = require('../middlewares/upload');
const { verifyToken, verifyTokenAndAdmin } = require('../middlewares/verifytoken');
const { authorize } = require('../middlewares/authorize');
const { createRoleRequest, getAllRoleRequests, updateRoleRequestStatus } = require('../Controllers/roleRequestController');

router.get('/', verifyToken, authorize('admin', 'administration', 'agent'), getAllUser);
router.get('/profile/:id', verifyToken, getProfile);

// 📝 Change User Type / Role (Admin only)
router.patch('/:id/change-user-type', verifyTokenAndAdmin, changeUserType);

// 📝 Role Requests (Representative & Agent)
router.post('/request-role', verifyToken, createRoleRequest);
router.get('/role-requests', verifyToken, authorize('admin', 'administration', 'agent'), getAllRoleRequests);
router.patch('/role-requests/:id/status', verifyToken, authorize('admin', 'administration', 'agent'), updateRoleRequestStatus);

// 🚫 Account Suspension & Blocking (Admin & Agent)
router.get('/suspended', verifyToken, authorize('admin', 'administration', 'agent'), getSuspendedUsers);
router.patch('/suspend/:id', verifyToken, authorize('admin', 'administration', 'agent'), suspendUser);
router.patch('/:id/suspend', verifyToken, authorize('admin', 'administration', 'agent'), suspendUser);
router.put('/:id/suspend', verifyToken, authorize('admin', 'administration', 'agent'), suspendUser);

router.patch('/unsuspend/:id', verifyToken, authorize('admin', 'administration', 'agent'), unsuspendUser);
router.patch('/:id/unsuspend', verifyToken, authorize('admin', 'administration', 'agent'), unsuspendUser);
router.put('/:id/unsuspend', verifyToken, authorize('admin', 'administration', 'agent'), unsuspendUser);

router.put('/:id/block', verifyToken, authorize('admin', 'administration', 'agent'), blockUser);
router.patch('/:id/block', verifyToken, authorize('admin', 'administration', 'agent'), blockUser);

router.put('/:id/unblock', verifyToken, authorize('admin', 'administration', 'agent'), unblockUser);
router.patch('/:id/unblock', verifyToken, authorize('admin', 'administration', 'agent'), unblockUser);

// 🚫 Banned Devices & Identifiers (Admin only)
router.get('/banned-devices', verifyTokenAndAdmin, getBannedDevices);
router.delete('/banned-devices/:id', verifyTokenAndAdmin, unbanBannedDevice);

// 🚗 Admin & Agent: Toggle or set representative vehicle edit permissions (Lock/Unlock)
router.patch('/:id/vehicle-edit-permissions', verifyToken, authorize('admin', 'administration', 'agent'), toggleVehicleEditPermission);
router.patch('/:id/toggle-vehicle-edit', verifyToken, authorize('admin', 'administration', 'agent'), toggleVehicleEditPermission);

// 🚗 Live map tracking: Get all online available representatives (MUST be before /:id)
router.get('/online-representatives/locations', verifyToken, getOnlineRepresentatives);

// 📍 Representative / User Governorate update
router.patch('/:id/governorate', verifyToken, updateUserGovernorate);

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

// 📦 Admin, Administration & Agent: Get orders delivered by a representative (filterable by month/year)
router.get('/:id/representative-orders', verifyToken, authorize('admin', 'administration', 'agent'), getRepresentativeOrders);

// ⭐ Admin, Administration & Agent: Get ratings received by / given by a representative
router.get('/:id/representative-ratings', verifyToken, authorize('admin', 'administration', 'agent'), getRepresentativeRatingsAdmin);

// Routes moved to top to prevent /:id override

module.exports = router;

