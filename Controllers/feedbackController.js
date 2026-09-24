const asyncHandler = require('express-async-handler');
const { Feedback } = require('../models/Feedback');
const { User } = require('../middlewares/User');
const { notifyClient } = require('../services/notifyClient');

/**
 * @description Submit user feedback/opinion/issue
 * @route POST /api/feedback
 * @access Private (authenticated users)
 */
const submitFeedback = asyncHandler(async (req, res) => {
    const { description } = req.body;

    if (!description || typeof description !== 'string' || description.trim().length < 2) {
        return res.status(400).json({
            success: false,
            message: 'برجاء كتابة رأيك أو المشكلة بوضوح (حرفين على الأقل)',
        });
    }

    const trimmedDescription = description.trim();
    if (trimmedDescription.length > 3000) {
        return res.status(400).json({
            success: false,
            message: 'نص الرأي طويل جداً، الحد الأقصى 3000 حرف',
        });
    }

    const userId = req.user?.id || req.user?._id;
    if (!userId) {
        return res.status(401).json({
            success: false,
            message: 'غير مصرح، برجاء تسجيل الدخول',
        });
    }

    // Fetch user details for accurate snapshot
    const user = await User.findById(userId).select('firstName lastName phone email userType');
    const fullName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '';
    const phone = user?.phone || '';
    const email = user?.email || '';
    const userType = user?.userType || req.user?.userType || 'NormalUser';

    const feedback = await Feedback.create({
        userId,
        description: trimmedDescription,
        userName: fullName,
        userPhone: phone,
        userEmail: email,
        userType,
        status: 'pending',
    });

    res.status(201).json({
        success: true,
        message: 'تم إرسال رأيك بنجاح، شكراً لمشاركتك معنا في تطوير وصول!',
        data: feedback,
    });
});

/**
 * @description Get all feedback with user details for admin
 * @route GET /api/feedback
 * @access Private/Admin
 */
const getAllFeedback = asyncHandler(async (req, res) => {
    const { userType, status, search } = req.query;
    let filter = {};

    if (userType && userType !== 'all') {
        filter.userType = new RegExp(`^${userType}$`, 'i');
    }

    if (status && status !== 'all') {
        filter.status = status;
    }

    if (search && search.trim().length > 0) {
        const searchRegex = new RegExp(search.trim(), 'i');
        filter.$or = [
            { description: searchRegex },
            { userName: searchRegex },
            { userPhone: searchRegex },
            { userEmail: searchRegex },
        ];
    }

    const feedbackList = await Feedback.find(filter)
        .populate('userId', 'firstName lastName email phone userType profileImage status createdAt')
        .sort({ createdAt: -1 })
        .lean();

    res.status(200).json({
        success: true,
        count: feedbackList.length,
        data: feedbackList,
    });
});

/**
 * @description Delete feedback item
 * @route DELETE /api/feedback/:id
 * @access Private/Admin
 */
const deleteFeedback = asyncHandler(async (req, res) => {
    const { id } = req.params;

    const feedback = await Feedback.findByIdAndDelete(id);
    if (!feedback) {
        return res.status(404).json({
            success: false,
            message: 'الملاحظة غير موجودة',
        });
    }

    res.status(200).json({
        success: true,
        message: 'تم حذف الملاحظة بنجاح',
    });
});

/**
 * @description Update feedback status or admin notes
 * @route PATCH /api/feedback/:id/status
 * @access Private/Admin
 */
const updateFeedbackStatus = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    const updateFields = {};
    if (status) {
        if (!['pending', 'in_progress', 'resolved'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'حالة غير صالحة',
            });
        }
        updateFields.status = status;
    }

    if (adminNotes !== undefined) {
        updateFields.adminNotes = adminNotes;
    }

    const updated = await Feedback.findByIdAndUpdate(
        id,
        { $set: updateFields },
        { new: true }
    ).populate('userId', 'firstName lastName email phone userType profileImage');

    if (!updated) {
        return res.status(404).json({
            success: false,
            message: 'الملاحظة غير موجودة',
        });
    }

    // إذا تم تحديد الملاحظة كـ "تم الحل"، إرسال إشعار فوري لصاحب الحساب
    if (status === 'resolved') {
        const targetUserId = updated.userId?._id || updated.userId;
        if (targetUserId) {
            const title = 'إدارة تطبيق وصول';
            const body = 'تم مراجعه طلبك وتم حل كل ما طلبته بنجاح شكرا لك نحن دائما في مساعدتك';
            notifyClient(targetUserId, title, body, {
                type: 'feedback_resolved',
                feedbackId: String(updated._id),
            }).catch((err) => {
                console.error('❌ [Feedback] Error sending resolution notification:', err);
            });
        }
    }

    res.status(200).json({
        success: true,
        message: 'تم تحديث الملاحظة بنجاح',
        data: updated,
    });
});

module.exports = {
    submitFeedback,
    getAllFeedback,
    deleteFeedback,
    updateFeedbackStatus,
};
