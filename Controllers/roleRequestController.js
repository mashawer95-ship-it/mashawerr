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

    if (!requestedRole || !['Representative', 'Agent'].includes(requestedRole)) {
        return res.status(400).json({ message: 'requestedRole must be Representative or Agent' });
    }

    if (!description || !phone) {
        return res.status(400).json({ message: 'description and phone are required' });
    }

    // Check if user already has a pending request
    const existingRequest = await RoleRequest.findOne({
        user: req.user.id,
        status: 'pending'
    });

    if (existingRequest) {
        const roleName = existingRequest.requestedRole === 'Agent' ? 'وكيل' : 'مندوب';
        return res.status(400).json({
            message: `لديك طلب انضمام معلق سابق كـ (${roleName}). يرجى انتظار مراجعة الإدارة.`
        });
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
    const isAgent = (req.user?.userType || req.fullUser?.userType || '').toString().trim().toLowerCase() === 'agent';
    const agentGov = (req.fullUser?.governorate || req.user?.governorate || '').trim().toLowerCase();

    const status = req.query.status;
    let filter = {};
    if (status) {
        filter.status = status;
    }

    if (isAgent) {
        // Strict Agent restriction: can ONLY see Representative requests, never Agent requests
        filter.requestedRole = 'Representative';
    }

    let requests = await RoleRequest.find(filter)
        .populate('user', 'firstName lastName email profileImage userType governorate phone')
        .sort({ createdAt: -1 });

    if (isAgent) {
        if (!agentGov) {
            return res.status(200).json([]);
        }
        requests = requests.filter(r => r.user && r.user.governorate && r.user.governorate.toLowerCase().includes(agentGov));
    } else if (req.query.governorate && req.query.governorate.trim()) {
        const govLower = req.query.governorate.trim().toLowerCase();
        requests = requests.filter(r => r.user && r.user.governorate && r.user.governorate.toLowerCase().includes(govLower));
    }

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

    const isAgent = (req.user?.userType || req.fullUser?.userType || '').toString().trim().toLowerCase() === 'agent';
    const agentGov = (req.fullUser?.governorate || req.user?.governorate || '').trim().toLowerCase();

    if (isAgent) {
        // Strict Security: Agent can ONLY accept/reject Representative requests
        if (roleRequest.requestedRole !== 'Representative') {
            return res.status(403).json({
                message: 'عذراً، صلاحياتك كوكيل تتيح لك قبول ورفض طلبات المناديب فقط ولا يمكنك التحكم بطلبات الوكلاء.'
            });
        }

        // Strict Governorate check: applicant must belong to the Agent's governorate
        const applicantUser = await User.findById(roleRequest.user).select('governorate').lean();
        const applicantGov = (applicantUser?.governorate || '').toString().trim().toLowerCase();

        if (!agentGov || !applicantGov.includes(agentGov)) {
            return res.status(403).json({
                message: 'عذراً، هذا الطلب تابع لمحافظة أخرى ولا تملك صلاحية مراجعته.'
            });
        }
    }

    if (roleRequest.status !== 'pending') {
        return res.status(400).json({ message: `This request is already ${roleRequest.status}` });
    }

    if (status === 'approved') {
        const user = await User.findById(roleRequest.user);
        if (user) {
            if (roleRequest.requestedRole === 'Agent') {
                const targetGov = (user.governorate || '').trim();
                if (!targetGov) {
                    return res.status(400).json({
                        message: 'لا يمكن ترقية المستخدم إلى وكيل لعدم وجود محافظة مسجلة في حسابه.'
                    });
                }
                const escapedGov = targetGov.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const existingAgent = await User.findOne({
                    _id: { $ne: user._id },
                    userType: { $regex: /^agent$/i },
                    governorate: { $regex: new RegExp(`^${escapedGov}$`, 'i') }
                });
                if (existingAgent) {
                    const agentName = `${existingAgent.firstName || ''} ${existingAgent.lastName || ''}`.trim() || 'آخر';
                    return res.status(400).json({
                        message: `عذراً، يوجد وكيل مسجل بالفعل لمحافظة (${targetGov}) وهو (${agentName}). لا يمكن تعيين أكثر من وكيل لنفس المحافظة.`
                    });
                }
            }
            user.userType = roleRequest.requestedRole;
            await user.save();
        }
    }

    roleRequest.status = status;
    await roleRequest.save();

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
