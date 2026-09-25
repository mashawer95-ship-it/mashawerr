/**
 * utils/orderAcceptanceGuard.js
 * Comprehensive guard function to validate representative eligibility before accepting orders.
 */

const { User } = require('../middlewares/User');

/**
 * Validates whether a representative is eligible to accept an order.
 * Returns { canAccept: true } or { canAccept: false, statusCode: 403, code: '...', message: '...' }
 *
 * @param {string|mongoose.Types.ObjectId} repId
 * @returns {Promise<{ canAccept: boolean, statusCode?: number, code?: string, message?: string }>}
 */
async function checkRepCanAcceptOrder(repId) {
    if (!repId) {
        return { canAccept: true };
    }

    // 1. Check User profile & Receiving Orders status (isAvailable)
    const rep = await User.findById(repId).select('vehicleNumber vehicleColor vehicleModel vehicleImage vehicleTypeId vehicleTypeName isAvailable');
    if (!rep) {
        return {
            canAccept: false,
            statusCode: 404,
            code: 'USER_NOT_FOUND',
            message: 'المستخدم غير موجود',
        };
    }

    if (!rep.isAvailable) {
        return {
            canAccept: false,
            statusCode: 403,
            code: 'RECEIVING_ORDERS_DISABLED',
            message: 'يجب تفعيل وضع استقبال الطلبات أولاً لقبول أي طلب',
        };
    }

    // 2. Check Vehicle info completion
    if (!rep.vehicleNumber || !rep.vehicleColor || !rep.vehicleModel || !rep.vehicleImage || (!rep.vehicleTypeId && !rep.vehicleTypeName)) {
        return {
            canAccept: false,
            statusCode: 403,
            code: 'VEHICLE_INFO_INCOMPLETE',
            message: 'لا يمكنك قبول الطلبات قبل إكمال جميع بيانات المركبة (الصورة، الرقم، اللون، الموديل، ونوع المركبة) في إعدادات المركبة.',
        };
    }

    // Shifts and attendance checks removed per business requirement:
    // Representatives are no longer bound by shifts or attendance/absence.
    // Live tracking (online/offline availability and active orders) is fully maintained.
    return { canAccept: true };
}

module.exports = {
    checkRepCanAcceptOrder,
};
