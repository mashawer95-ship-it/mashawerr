/**
 * utils/orderAcceptanceGuard.js
 * Comprehensive guard function to validate representative eligibility before accepting orders.
 */

const { User } = require('../middlewares/User');
const AttendanceRecord = require('../models/AttendanceRecord');
const { detectCurrentShift, evaluateShiftTiming } = require('./shiftDetector');

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

    // 3. Detect all active shifts assigned to this representative
    const Shift = require('../models/Shift');
    const repShifts = await Shift.find({
        isActive: true,
        representativeIds: repId,
    }).sort({ startTime: 1 }).lean();

    // Guard: Representative MUST have an assigned shift before accepting orders
    if (!repShifts || repShifts.length === 0) {
        return {
            canAccept: false,
            statusCode: 403,
            code: 'NO_SHIFT_ASSIGNED',
            message: 'عذراً، لم يتم تخصيص أي شيفت لك بعد. لا يمكنك قبول الطلبات حتى يتم تحديد شيفت وتسجيل الحضور.',
        };
    }

    const { shift, referenceDateStr } = await detectCurrentShift(repId);
    const shiftsToEvaluate = repShifts;

    if (shiftsToEvaluate.length > 0) {
        const now = new Date();
        let isAnyShiftActive = false;
        let nextShiftStartTime = null;
        let allShiftsEnded = true;

        for (const s of shiftsToEvaluate) {
            const timing = evaluateShiftTiming(s, now);
            if (timing.hasShift) {
                // Shift is active for accepting orders ONLY if current time is >= shiftStart AND < shiftEnd
                if (!timing.isBeforeShiftStart && timing.isBeforeShiftEnd) {
                    isAnyShiftActive = true;
                    break;
                }
                if (timing.isBeforeShiftStart) {
                    allShiftsEnded = false;
                    if (!nextShiftStartTime) nextShiftStartTime = s.startTime;
                }
            }
        }

        if (!isAnyShiftActive) {
            if (!allShiftsEnded && nextShiftStartTime) {
                return {
                    canAccept: false,
                    statusCode: 403,
                    code: 'OUTSIDE_SHIFT_HOURS',
                    message: `عذراً، لم يبدأ وقت الشيفت الخاص بك بعد. تبدأ مواعيد الشيفت الساعة ${nextShiftStartTime}`,
                };
            }
            return {
                canAccept: false,
                statusCode: 403,
                code: 'SHIFT_ENDED',
                message: 'الشيفت الخاص بك انتهى، انتظر ميعاد الشيفت القادم',
            };
        }
    }

    // 4. Check Attendance Record for reference date
    const attendanceRec = await AttendanceRecord.findOne({
        representativeId: repId,
        dateStr: referenceDateStr,
    }).select('isManualCheckIn manualCheckInAt manualCheckOutAt status').lean();

    // Must have recorded check-in
    if (!attendanceRec || (!attendanceRec.isManualCheckIn && !attendanceRec.manualCheckInAt)) {
        return {
            canAccept: false,
            statusCode: 403,
            code: 'ATTENDANCE_REQUIRED',
            message: 'لا يمكن قبول الطلبات حتى تقوم بتسجيل الحضور',
        };
    }

    // Must NOT have checked out
    if (attendanceRec.manualCheckOutAt != null) {
        return {
            canAccept: false,
            statusCode: 403,
            code: 'CHECKED_OUT_ALREADY',
            message: 'لقد قمت بتسجيل الانصراف، لا يمكنك قبول أي طلب حتى تسجيل الحضور في الشيفت القادم',
        };
    }

    // Must NOT be marked absent
    if (attendanceRec.status === 'absent') {
        return {
            canAccept: false,
            statusCode: 403,
            code: 'MARKED_ABSENT',
            message: 'تم تسجيلك كغائب لهذا اليوم، لا يمكنك قبول الطلبات',
        };
    }

    return { canAccept: true };
}

module.exports = {
    checkRepCanAcceptOrder,
};
