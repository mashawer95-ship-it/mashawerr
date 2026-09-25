const asyncHandler = require('express-async-handler');
const { RoleRequest } = require('../models/RoleRequest');
const { User } = require('../middlewares/User');

/**
 * @description Create a new role request (Representative or Agent)
 * @route POST /api/users/request-role
 * @access Private (logged in users)
 */
const createRoleRequest = asyncHandler(async (req, res) => {
    const { requestedRole, description, phone } = req.body;

    if (!requestedRole || requestedRole !== 'Representative') {
        return res.status(400).json({ message: 'requestedRole must be Representative' });
    }

    if (!description || !phone) {
        return res.status(400).json({ message: 'description and phone are required' });
    }

    // Check if user already has a pending request for the same role
    const existingRequest = await RoleRequest.findOne({
        user: req.user.id,
        status: 'pending'
    });

    if (existingRequest) {
        return res.status(400).json({ message: 'You already have a pending role request.' });
    }

    const roleRequest = await RoleRequest.create({
        user: req.user.id,
        requestedRole,
        description,
        phone,
        status: 'pending'
    });

    res.status(201).json({
        message: 'Role request submitted successfully',
        roleRequest
    });
});

/**
 * @description Get all role requests
 * @route GET /api/users/role-requests
 * @access Private/Admin
 */
const getAllRoleRequests = asyncHandler(async (req, res) => {
    const status = req.query.status;
    let filter = {};
    if (status) {
        filter.status = status;
    }

    const requests = await RoleRequest.find(filter)
        .populate('user', 'firstName lastName email profileImage userType')
        .sort({ createdAt: -1 });

    res.status(200).json(requests);
});

/**
 * @description Update role request status (approve/reject)
 * @route PATCH /api/users/role-requests/:id/status
 * @access Private/Admin
 */
const updateRoleRequestStatus = asyncHandler(async (req, res) => {
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: 'Status must be approved or rejected' });
    }

    const roleRequest = await RoleRequest.findById(req.params.id);
    if (!roleRequest) {
        return res.status(404).json({ message: 'Role request not found' });
    }

    if (roleRequest.status !== 'pending') {
        return res.status(400).json({ message: `This request is already ${roleRequest.status}` });
    }

    roleRequest.status = status;
    await roleRequest.save();

    if (status === 'approved') {
        const user = await User.findById(roleRequest.user);
        if (user) {
            user.userType = roleRequest.requestedRole;
            await user.save();
        }
    }

    res.status(200).json({
        message: `Role request ${status} successfully`,
        roleRequest
    });
});

module.exports = {
    createRoleRequest,
    getAllRoleRequests,
    updateRoleRequestStatus
};
