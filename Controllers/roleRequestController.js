const asyncHandler = require('express-async-handler');
const { RoleRequest } = require('../models/RoleRequest');
const { User } = require('../middlewares/User');
const { normalizePagination, buildPaginationMetadata, setPaginationHeaders } = require('../utils/pagination');

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
    const agentGov = (req.fullUser?.governorate || req.user?.governorate || '').trim();

    const { page: safePage, limit: safeLimit, skip } = normalizePagination({
        page: req.query.page,
        limit: req.query.limit,
        defaultLimit: 20,
        maxLimit: 50,
    });

    const status = req.query.status;
    let filter = {};
    if (status) {
        filter.status = status;
    }

    if (isAgent) {
        // Strict Agent restriction: can ONLY see Representative requests, never Agent requests
        filter.requestedRole = 'Representative';

        if (!agentGov) {
            setPaginationHeaders(res, 0, safePage, safeLimit);
            return res.status(200).json({
                success: true,
                requests: [],
                data: [],
                roleRequests: [],
                total: 0,
                page: safePage,
                limit: safeLimit,
                totalPages: 0,
                pagination: buildPaginationMetadata(0, safePage, safeLimit),
            });
        }

        const userIds = await User.find({
            governorate: { $regex: new RegExp(agentGov.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i') }
        }).distinct('_id');
        filter.user = { $in: userIds };
    } else if (req.query.governorate && req.query.governorate.trim()) {
        const userIds = await User.find({
            governorate: { $regex: new RegExp(req.query.governorate.trim(), 'i') }
        }).distinct('_id');
        filter.user = { $in: userIds };
    }

    const [requests, total] = await Promise.all([
        RoleRequest.find(filter)
            .populate('user', 'firstName lastName email profileImage userType governorate phone')
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(safeLimit)
            .lean(),
        RoleRequest.countDocuments(filter),
    ]);

    const meta = buildPaginationMetadata(total, safePage, safeLimit);
    setPaginationHeaders(res, total, safePage, safeLimit);

    return res.status(200).json({
        success: true,
        requests,
        data: requests,
        roleRequests: requests,
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: meta.totalPages,
        hasNextPage: meta.hasNextPage,
        hasPrevPage: meta.hasPrevPage,
        nextPage: meta.nextPage,
        prevPage: meta.prevPage,
        pagination: meta,
    });
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
