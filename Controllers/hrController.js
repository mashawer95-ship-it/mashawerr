const expressAsyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Shift = require('../models/Shift');
const AttendanceRecord = require('../models/AttendanceRecord');
const RepActivityLog = require('../models/RepActivityLog');
const { User } = require('../middlewares/User');
const { Order } = require('../middlewares/Order');
const {
    setRepSession,
    getRepSession,
    clearRepSession,
    setRepAppState,
    getRepAppState,
    touchRepAppState,
    setRepCurrentOrder,
    getRepCurrentOrder,
    clearRepCurrentOrder,
    cacheLiveDashboard,
    getCachedLiveDashboard,
    invalidateLiveDashboard,
    invalidateActiveShifts,
} = require('../redis/hrRedis');
const {
    formatDateStr,
    getDateMetadata,
    detectCurrentShift,
    calculate24hCoverage,
    evaluateShiftTiming,
} = require('../utils/shiftDetector');
const logger = require('../utils/logger');

const sanitizeRepresentativeIds = (ids) => {
    if (!Array.isArray(ids)) return [];
    const uniqueIds = new Set();
    ids.forEach(item => {
        if (!item) return;
        if (typeof item === 'object' && item._id) {
            uniqueIds.add(item._id.toString());
            return;
        }
        if (typeof item === 'object' && item.id) {
            uniqueIds.add(item.id.toString());
            return;
        }
        const str = String(item).trim();
        if (str.startsWith('{') && str.includes('_id:')) {
            const match = str.match(/_id:\s*([a-fA-F0-9]{24})/);
            if (match) {
                uniqueIds.add(match[1]);
                return;
            }
        }
        if (/^[a-fA-F0-9]{24}$/.test(str)) {
            uniqueIds.add(str);
        }
    });
    return Array.from(uniqueIds);
};

/**
 * Helper to ensure a representative is assigned to AT MOST ONE shift.
 * Removes assigned representative IDs from all other shifts.
 */
const ensureUniqueShiftAssignments = async (targetShiftId, repIds) => {
    if (!repIds || repIds.length === 0) return;
    await Shift.updateMany(
        { _id: { $ne: targetShiftId } },
        { $pull: { representativeIds: { $in: repIds } } }
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. SHIFT MANAGEMENT (Admin)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new Shift
 * POST /api/hr/shifts
 */
const createShift = expressAsyncHandler(async (req, res) => {
    const { name, startTime, endTime, days, representativeIds } = req.body;

    if (!name || !startTime || !endTime) {
        return res.status(400).json({ message: 'Shift name, startTime, and endTime are required' });
    }

    const DAY_MAP = {
        'Saturday': 'Sat', 'Sunday': 'Sun', 'Monday': 'Mon', 'Tuesday': 'Tue',
        'Wednesday': 'Wed', 'Thursday': 'Thu', 'Friday': 'Fri',
        'Sat': 'Sat', 'Sun': 'Sun', 'Mon': 'Mon', 'Tue': 'Tue',
        'Wed': 'Wed', 'Thu': 'Thu', 'Fri': 'Fri',
    };

    const cleanDays = Array.isArray(days)
        ? days.map(d => DAY_MAP[d] || d)
        : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    const cleanRepIds = sanitizeRepresentativeIds(representativeIds);

    const shift = new Shift({
        name,
        startTime,
        endTime,
        days: cleanDays,
        representativeIds: cleanRepIds,
        createdBy: req.user ? req.user.id : null,
    });

    await shift.save();

    // Ensure representatives belong ONLY to this shift
    await ensureUniqueShiftAssignments(shift._id, cleanRepIds);

    await invalidateActiveShifts();
    await invalidateLiveDashboard();

    const allShifts = await Shift.find({ isActive: true }).lean();
    const coverage = calculate24hCoverage(allShifts);

    res.status(201).json({
        message: 'Shift created successfully',
        shift,
        coverage,
    });
});

/**
 * Get all Shifts with coverage analysis
 * GET /api/hr/shifts
 */
const getShifts = expressAsyncHandler(async (req, res) => {
    const shifts = await Shift.find()
        .populate('representativeIds', 'firstName lastName phone profileImage isAvailable')
        .sort({ startTime: 1 })
        .lean();

    const activeShifts = shifts.filter(s => s.isActive);
    const coverage = calculate24hCoverage(activeShifts);

    res.json({
        shifts,
        coverage,
    });
});

/**
 * Update Shift
 * PATCH /api/hr/shifts/:id
 */
const updateShift = expressAsyncHandler(async (req, res) => {
    const { id } = req.params;
    const shift = await Shift.findById(id);

    if (!shift) {
        return res.status(404).json({ message: 'Shift not found' });
    }

    const DAY_MAP = {
        'Saturday': 'Sat', 'Sunday': 'Sun', 'Monday': 'Mon', 'Tuesday': 'Tue',
        'Wednesday': 'Wed', 'Thursday': 'Thu', 'Friday': 'Fri',
        'Sat': 'Sat', 'Sun': 'Sun', 'Mon': 'Mon', 'Tue': 'Tue',
        'Wed': 'Wed', 'Thu': 'Thu', 'Fri': 'Fri',
    };

    const fields = ['name', 'startTime', 'endTime', 'isActive'];
    fields.forEach(field => {
        if (req.body[field] !== undefined) {
            shift[field] = req.body[field];
        }
    });

    let cleanRepIds = null;
    if (req.body.representativeIds !== undefined) {
        cleanRepIds = sanitizeRepresentativeIds(req.body.representativeIds);
        shift.representativeIds = cleanRepIds;
    }

    if (req.body.days && Array.isArray(req.body.days)) {
        shift.days = req.body.days.map(d => DAY_MAP[d] || d);
    }

    await shift.save();

    if (cleanRepIds && cleanRepIds.length > 0) {
        await ensureUniqueShiftAssignments(shift._id, cleanRepIds);
    }

    await invalidateActiveShifts();
    await invalidateLiveDashboard();

    const allShifts = await Shift.find({ isActive: true }).lean();
    const coverage = calculate24hCoverage(allShifts);

    res.json({
        message: 'Shift updated successfully',
        shift,
        coverage,
    });
});

/**
 * Admin Override Attendance Record (Status, Check-in Time, Check-out Time, Notes, Audit Trail)
 * PATCH /api/hr/attendance/override
 */
const adminOverrideAttendance = expressAsyncHandler(async (req, res) => {
    const { representativeId, repId: fallbackRepId, dateStr, status, manualCheckInAt, manualCheckOutAt, notes } = req.body;
    const repId = representativeId || fallbackRepId;

    if (!repId || !dateStr) {
        return res.status(400).json({ message: 'representativeId and dateStr are required' });
    }

    const adminUser = req.user || {};
    const adminName = `${adminUser.firstName || ''} ${adminUser.lastName || ''}`.trim() || adminUser.email || 'الأدمن';
    const nowStr = new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });

    const newStatus = status || 'present';
    const dateObj = new Date(dateStr);
    const meta = getDateMetadata(dateObj);

    let record = await AttendanceRecord.findOne({
        representativeId: repId,
        dateStr,
    });

    let changesDescription = [];

    if (!record) {
        const { shift } = await detectCurrentShift(repId, dateObj);
        record = new AttendanceRecord({
            representativeId: repId,
            shiftId: shift ? shift._id : null,
            date: meta.date,
            dateStr,
            week: meta.week,
            month: meta.month,
            year: meta.year,
            status: newStatus,
            isManualCheckIn: newStatus === 'present' || newStatus === 'partial',
        });
    }

    // 1. Update Status
    if (record.status !== newStatus) {
        changesDescription.push(`تعديل حالة اليوم إلى [${newStatus === 'present' ? 'حاضر ✅' : (newStatus === 'absent' ? 'غياب ❌' : 'حضور جزئي ⚠️')}]`);
        record.status = newStatus;
    }

    if (newStatus === 'absent') {
        record.isManualCheckIn = false;
        record.manualCheckInAt = null;
        record.manualCheckOutAt = null;
    } else {
        record.isManualCheckIn = true;

        const formatCairoTimeStr = (dateVal) => {
            try {
                const d = new Date(dateVal);
                return d.toLocaleTimeString('ar-EG', {
                    timeZone: 'Africa/Cairo',
                    hour: '2-digit',
                    minute: '2-digit',
                });
            } catch (_) {
                return String(dateVal);
            }
        };

        // 2. Update Check-In Time if provided
        if (manualCheckInAt) {
            record.manualCheckInAt = new Date(manualCheckInAt);
            changesDescription.push(`وقت الحضور إلى (${formatCairoTimeStr(manualCheckInAt)})`);
        } else if (!record.manualCheckInAt) {
            record.manualCheckInAt = new Date();
        }

        // 3. Update Check-Out Time if provided
        if (manualCheckOutAt) {
            record.manualCheckOutAt = new Date(manualCheckOutAt);
            changesDescription.push(`وقت الانصراف إلى (${formatCairoTimeStr(manualCheckOutAt)})`);
        }
    }

    // 4. Construct Audit Trail Note
    const changesSummaryText = changesDescription.length > 0
        ? changesDescription.join('، و')
        : 'تحديث بيانات اليوم';

    const auditLogText = `تم التعديل على هذا اليوم من حيث: ${changesSummaryText} بواسطة (${adminName}) بتاريخ ${nowStr}`;

    const customNotes = notes ? notes.trim() : '';
    record.notes = customNotes ? `${customNotes}\n📌 [سجل الأدمن]: ${auditLogText}` : `📌 [سجل الأدمن]: ${auditLogText}`;

    await record.save();
    await invalidateLiveDashboard();

    res.json({
        message: 'تم تحديث حالة وسجلات الحضور والانصراف بنجاح',
        record,
    });
});

/**
 * Delete Shift
 * DELETE /api/hr/shifts/:id
 */
const deleteShift = expressAsyncHandler(async (req, res) => {
    const { id } = req.params;
    const shift = await Shift.findByIdAndDelete(id);

    if (!shift) {
        return res.status(404).json({ message: 'Shift not found' });
    }

    await invalidateActiveShifts();
    await invalidateLiveDashboard();

    res.json({ message: 'Shift deleted successfully', shiftId: id });
});

/**
 * Assign Representatives to Shift
 * POST /api/hr/shifts/:id/assign
 */
const assignRepsToShift = expressAsyncHandler(async (req, res) => {
    const { id } = req.params;
    const { representativeIds } = req.body;

    if (!Array.isArray(representativeIds)) {
        return res.status(400).json({ message: 'representativeIds must be an array' });
    }

    const shift = await Shift.findById(id);
    if (!shift) {
        return res.status(404).json({ message: 'Shift not found' });
    }

    const cleanRepIds = sanitizeRepresentativeIds(representativeIds);
    const newIds = cleanRepIds.map(rId => new mongoose.Types.ObjectId(rId));
    shift.representativeIds = Array.from(
        new Set([...shift.representativeIds.map(id => id.toString()), ...cleanRepIds])
    ).map(id => new mongoose.Types.ObjectId(id));

    await shift.save();

    await ensureUniqueShiftAssignments(shift._id, cleanRepIds);

    await invalidateActiveShifts();
    await invalidateLiveDashboard();

    res.json({ message: 'Representatives assigned successfully', shift });
});

/**
 * Unassign a Representative from Shift
 * DELETE /api/hr/shifts/:id/assign/:repId
 */
const unassignRepFromShift = expressAsyncHandler(async (req, res) => {
    const { id, repId } = req.params;

    const shift = await Shift.findById(id);
    if (!shift) {
        return res.status(404).json({ message: 'Shift not found' });
    }

    shift.representativeIds = shift.representativeIds.filter(rId => rId.toString() !== repId);
    await shift.save();
    await invalidateActiveShifts();
    await invalidateLiveDashboard();

    res.json({ message: 'Representative removed from shift', shift });
});

/**
 * Get 24-hour Shift Coverage breakdown
 * GET /api/hr/shifts/coverage
 */
const getShiftCoverage = expressAsyncHandler(async (req, res) => {
    const activeShifts = await Shift.find({ isActive: true }).lean();
    const coverage = calculate24hCoverage(activeShifts);
    res.json(coverage);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ATTENDANCE — MANUAL (Representative Settings)
// ─────────────────────────────────────────────────────────────────────────────



/**
 * Representative Manual Check-in
 * POST /api/hr/attendance/manual-check-in
 */
const manualCheckIn = expressAsyncHandler(async (req, res) => {
    const repId = req.user.id;
    const { lat, lng, accuracy, address, deviceInfo } = req.body;

    if (lat !== undefined && (lat < -90 || lat > 90)) {
        return res.status(400).json({ message: 'Invalid latitude value' });
    }
    if (lng !== undefined && (lng < -180 || lng > 180)) {
        return res.status(400).json({ message: 'Invalid longitude value' });
    }

    let { shift, referenceDateStr, meta } = await detectCurrentShift(repId);
    if (!shift) {
        shift = await Shift.findOne({ isActive: true, representativeIds: repId }).lean();
    }

    // Guard: Representative MUST have an assigned shift before checking in
    if (!shift) {
        return res.status(403).json({
            code: 'NO_SHIFT_ASSIGNED',
            message: 'عذراً، لم يتم تخصيص أي شيفت لك بعد. لا يمكنك تسجيل الحضور حتى يقوم مسؤول الـ HR بتخصيص شيفت لك.',
        });
    }

    const now = new Date();
    const timing = evaluateShiftTiming(shift, now);

    // Guard: Check if representative already completed manual check-in today
    let record = await AttendanceRecord.findOne({
        representativeId: repId,
        dateStr: referenceDateStr,
    });

    if (record && record.isManualCheckIn) {
        return res.status(409).json({
            message: 'لقد قمت بتسجيل الحضور اليدوي بالفعل لهذا اليوم',
            record,
            shift,
        });
    }

    // Rule 1: Cannot check-in before shift startTime
    if (timing.hasShift && timing.isBeforeShiftStart) {
        return res.status(400).json({
            message: `عذراً، لم يبدأ وقت الشيفت بعد. يمكنك تسجيل الحضور بدءاً من الساعة ${shift.startTime}`,
            shift,
        });
    }

    // Rule 2: 15-minute grace period check. If past 15 mins -> mark absent & block check-in!
    if (timing.hasShift && timing.isPastGracePeriod) {
        if (!record) {
            record = new AttendanceRecord({
                representativeId: repId,
                shiftId: shift ? shift._id : null,
                date: meta.date,
                dateStr: referenceDateStr,
                week: meta.week,
                month: meta.month,
                year: meta.year,
                status: 'absent',
                notes: 'تم تسجيل غياب تلقائياً لانقضاء مهلة تسجيل الحضور (15 دقيقة من بداية الشيفت)',
            });
        } else {
            record.status = 'absent';
            record.notes = 'تم تسجيل غياب تلقائياً لانقضاء مهلة تسجيل الحضور (15 دقيقة من بداية الشيفت)';
        }
        await record.save();

        return res.status(400).json({
            message: `عذراً، لقد انتهت مهلة تسجيل الحضور المسموحة (15 دقيقة من بداية الشيفت الساعة ${shift.startTime}) وحالتك اليوم غياب ❌`,
            record,
            shift,
        });
    }

    const locationObj = { lat: lat || null, lng: lng || null, accuracy: accuracy || null, address: address || null };

    if (!record) {
        record = new AttendanceRecord({
            representativeId: repId,
            shiftId: shift ? shift._id : null,
            date: meta.date,
            dateStr: referenceDateStr,
            week: meta.week,
            month: meta.month,
            year: meta.year,
            status: 'present',
        });
    }

    record.manualCheckInAt = now;
    record.manualCheckInLocation = locationObj;
    record.manualCheckInDevice = deviceInfo || {};
    record.isManualCheckIn = true;
    record.status = 'present';
    if (shift) record.shiftId = shift._id;

    await record.save();

    // Permanent activity log entry
    await RepActivityLog.create({
        representativeId: repId,
        shiftId: shift ? shift._id : null,
        dateStr: referenceDateStr,
        week: meta.week,
        month: meta.month,
        year: meta.year,
        eventType: 'manual_check_in',
        timestamp: now,
        location: locationObj,
        metadata: { deviceInfo },
    });

    // Update Redis session
    await setRepSession(repId, {
        checkInAt: now.toISOString(),
        shiftId: shift ? shift._id.toString() : null,
        shiftName: shift ? shift.name : 'افتراضي',
        isOnline: true,
        lastSeen: Date.now(),
    });
    await setRepAppState(repId, 'open');
    await invalidateLiveDashboard();

    res.status(200).json({
        message: 'تم تسجيل الحضور بنجاح',
        record,
        currentShift: shift,
    });
});

/**
 * Representative Manual Check-out
 * POST /api/hr/attendance/manual-check-out
 */
const manualCheckOut = expressAsyncHandler(async (req, res) => {
    const repId = req.user.id;
    const { lat, lng, accuracy, address, deviceInfo } = req.body;

    let { shift, referenceDateStr, meta } = await detectCurrentShift(repId);
    if (!shift) {
        shift = await Shift.findOne({ isActive: true, representativeIds: repId }).lean();
    }

    const now = new Date();
    const timing = evaluateShiftTiming(shift, now);

    // Rule 1: Cannot check-out before shift endTime!
    if (timing.hasShift && timing.isBeforeShiftEnd) {
        return res.status(400).json({
            message: `عذراً، لا يمكنك تسجيل الانصراف قبل انتهاء وقت الشيفت في تمام الساعة ${shift.endTime}`,
            shift,
        });
    }

    // Rule 2: Cannot check-out after 1.5 hours (90 minutes) past shift endTime!
    if (timing.hasShift && timing.isPastCheckoutGracePeriod) {
        return res.status(400).json({
            message: 'عذراً، لقد انتهت مهلة تسجيل الانصراف المسموحة (ساعة ونصف من نهاية الشيفت). تم إغلاق تسجيل الانصراف لهذا الشيفت.',
            shift,
        });
    }

    const locationObj = { lat: lat || null, lng: lng || null, accuracy: accuracy || null, address: address || null };

    let record = await AttendanceRecord.findOne({
        representativeId: repId,
        dateStr: referenceDateStr,
    });

    if (!record) {
        record = new AttendanceRecord({
            representativeId: repId,
            shiftId: shift ? shift._id : null,
            date: meta.date,
            dateStr: referenceDateStr,
            week: meta.week,
            month: meta.month,
            year: meta.year,
            status: 'partial',
        });
    }

    record.manualCheckOutAt = now;
    record.manualCheckOutLocation = locationObj;
    await record.save();

    await RepActivityLog.create({
        representativeId: repId,
        shiftId: shift ? shift._id : null,
        dateStr: referenceDateStr,
        week: meta.week,
        month: meta.month,
        year: meta.year,
        eventType: 'manual_check_out',
        timestamp: now,
        location: locationObj,
        metadata: { deviceInfo },
    });

    await clearRepSession(repId);
    await setRepAppState(repId, 'closed');
    await invalidateLiveDashboard();

    res.json({
        message: 'تم تسجيل الانصراف بنجاح',
        record,
    });
});

/**
 * Get Representative's Today Attendance Status
 * GET /api/hr/attendance/my-today
 */
const getMyTodayAttendance = expressAsyncHandler(async (req, res) => {
    const repId = req.user.id;

    const repShifts = await Shift.find({
        isActive: true,
        representativeIds: repId,
    }).sort({ startTime: 1 }).lean();

    let { shift, referenceDateStr, meta } = await detectCurrentShift(repId);

    // If representative has NO assigned shifts at all, shift must be null
    if (!repShifts || repShifts.length === 0) {
        shift = null;
    } else if (!shift) {
        shift = repShifts[0];
    }

    let record = await AttendanceRecord.findOne({
        representativeId: repId,
        dateStr: referenceDateStr,
    }).populate('shiftId');

    // Auto-mark absent IF rep has an assigned shift, hasn't checked in, and 15-minute grace period passed!
    if (shift && repShifts && repShifts.length > 0) {
        const now = new Date();
        const timing = evaluateShiftTiming(shift, now);

        // If current time is within grace period, reset any stale 'absent' status so representative can check in
        if (!timing.isPastGracePeriod && record && !record.isManualCheckIn && record.status === 'absent') {
            await AttendanceRecord.deleteOne({ _id: record._id });
            record = null;
        }

        if (timing.isPastGracePeriod && (!record || (!record.isManualCheckIn && record.status !== 'present'))) {
            if (!record) {
                record = new AttendanceRecord({
                    representativeId: repId,
                    shiftId: shift._id,
                    date: meta.date,
                    dateStr: referenceDateStr,
                    week: meta.week,
                    month: meta.month,
                    year: meta.year,
                    status: 'absent',
                    notes: 'تم تسجيل غياب تلقائياً لانقضاء مهلة تسجيل الحضور (15 دقيقة من بداية الشيفت)',
                });
            } else if (record.status !== 'absent') {
                record.status = 'absent';
                record.notes = 'تم تسجيل غياب تلقائياً لانقضاء مهلة تسجيل الحضور (15 دقيقة من بداية الشيفت)';
            }
            await record.save();
        }
    }

    res.json({
        record: record || null,
        currentShift: shift || null,
        shift: shift || null,
        shifts: repShifts || [],
        dateStr: referenceDateStr,
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ATTENDANCE — AUTOMATIC BACKGROUND TRACKING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * App Open Hook (Automatic background)
 * POST /api/hr/attendance/app-open
 */
const appOpen = expressAsyncHandler(async (req, res) => {
    const repId = req.user.id;
    const { shift, referenceDateStr, meta } = await detectCurrentShift(repId);
    const now = new Date();

    let record = await AttendanceRecord.findOne({
        representativeId: repId,
        dateStr: referenceDateStr,
    });

    if (!record) {
        record = new AttendanceRecord({
            representativeId: repId,
            shiftId: shift ? shift._id : null,
            date: meta.date,
            dateStr: referenceDateStr,
            week: meta.week,
            month: meta.month,
            year: meta.year,
            status: 'absent',
        });
    }

    if (!record.appOpenAt) {
        record.appOpenAt = now;
    }
    record.sessionLogs.push({ openAt: now });
    await record.save();

    await RepActivityLog.create({
        representativeId: repId,
        shiftId: shift ? shift._id : null,
        dateStr: referenceDateStr,
        week: meta.week,
        month: meta.month,
        year: meta.year,
        eventType: 'app_open',
        timestamp: now,
    });

    await setRepAppState(repId, 'open');
    await touchRepAppState(repId);
    await invalidateLiveDashboard();

    res.json({ message: 'App open recorded', record, currentShift: shift });
});

/**
 * App Close Hook (Automatic background)
 * POST /api/hr/attendance/app-close
 */
const appClose = expressAsyncHandler(async (req, res) => {
    const repId = req.user.id;
    const { shift, referenceDateStr, meta } = await detectCurrentShift(repId);
    const now = new Date();

    let record = await AttendanceRecord.findOne({
        representativeId: repId,
        dateStr: referenceDateStr,
    });

    if (record) {
        record.appCloseAt = now;
        if (record.sessionLogs && record.sessionLogs.length > 0) {
            const lastSession = record.sessionLogs[record.sessionLogs.length - 1];
            if (!lastSession.closeAt) {
                lastSession.closeAt = now;
                const diffMs = now - new Date(lastSession.openAt);
                lastSession.durationMinutes = Math.max(1, Math.round(diffMs / 60000));
            }
        }
        let totalMins = 0;
        record.sessionLogs.forEach(s => {
            if (s.durationMinutes) totalMins += s.durationMinutes;
        });
        record.totalOnlineMinutes = totalMins;
        await record.save();
    }

    await RepActivityLog.create({
        representativeId: repId,
        shiftId: shift ? shift._id : null,
        dateStr: referenceDateStr,
        week: meta.week,
        month: meta.month,
        year: meta.year,
        eventType: 'app_close',
        timestamp: now,
    });

    await setRepAppState(repId, 'closed');
    await invalidateLiveDashboard();

    res.json({ message: 'App close recorded' });
});

/**
 * Heartbeat Hook (Every 2 mins)
 * POST /api/hr/attendance/heartbeat
 */
const heartbeat = expressAsyncHandler(async (req, res) => {
    const repId = req.user.id;
    await touchRepAppState(repId);
    await setRepAppState(repId, 'open');

    const { referenceDateStr } = await detectCurrentShift(repId);
    await AttendanceRecord.updateOne(
        { representativeId: repId, dateStr: referenceDateStr },
        { $inc: { totalOnlineMinutes: 2 } }
    );
    await invalidateLiveDashboard();

    res.json({ ok: true, timestamp: Date.now() });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. LIVE TRACKING & ADMIN DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get Real-time Live Tracking Dashboard
 * GET /api/hr/tracking/live
 */
const getLiveTracking = expressAsyncHandler(async (req, res) => {
    if (req.query.refresh !== 'true') {
        const cached = await getCachedLiveDashboard();
        if (cached) return res.json(cached);
    }

    const reps = await User.find({
        $or: [
            { userType: { $regex: /representative|driver/i } },
            { vehicleNumber: { $ne: null } }
        ]
    })
        .select('firstName lastName email phone profileImage isAvailable lastLocation status vehicleNumber vehicleModel')
        .lean();

    const activeShifts = await Shift.find({ isActive: true }).lean();

    const liveReps = [];
    let onlineCount = 0;
    let onOrderCount = 0;
    let offlineInShiftCount = 0;
    const nowTs = Date.now();

    for (const rep of reps) {
        const repId = rep._id.toString();
        const appStateObj = await getRepAppState(repId);
        const sessionObj = await getRepSession(repId);
        let currentOrder = await getRepCurrentOrder(repId);

        // Senior Active Order Verification: Query MongoDB to ensure order is truly active
        // 'waiting' is intentionally EXCLUDED from ACTIVE_STATUSES - it is a pending/queued state, not an in-progress delivery
        const ACTIVE_STATUSES = ['accepted', 'preparing', 'picked_up', 'on_way', 'arrived', 'reaching_pickup', 'reaching_delivery', 'confirmed', 'processing', 'shipped', 'in_transit'];
        const INACTIVE_STATUSES = ['completed', 'delivered', 'cancelled', 'canceled', 'rejected', 'waiting', 'failed', 'returned', 'released'];

        const findOrderByIdOrNumber = async (Model, rawId) => {
            if (!rawId) return null;
            const str = rawId.toString().trim();
            const isObjectId = /^[a-fA-F0-9]{24}$/.test(str);
            const num = Number(str);

            const query = [];
            if (isObjectId) query.push({ _id: str });
            if (!isNaN(num)) {
                query.push({ orderId: num });
            }
            if (query.length === 0) return null;

            try {
                return await Model.findOne({ $or: query }).select('_id orderId status representativeId driverId').lean();
            } catch (_) {
                return null;
            }
        };

        let isRealActiveOrder = false;

        if (currentOrder && currentOrder.orderId) {
            const { Order } = require('../middlewares/Order');

            const delOrder = await findOrderByIdOrNumber(Order, currentOrder.orderId);
            if (delOrder) {
                const statusStr = (delOrder.status || '').toString().toLowerCase();
                const orderRepId = (delOrder.representativeId || delOrder.driverId || '').toString();
                const isAssignedToThisRep = Boolean(orderRepId && orderRepId === repId);
                const isInactive = INACTIVE_STATUSES.includes(statusStr);

                if (isInactive || !isAssignedToThisRep) {
                    currentOrder = null;
                    await clearRepCurrentOrder(repId);
                } else {
                    const displayNum = delOrder.orderId || delOrder._id;
                    currentOrder.orderId = String(displayNum);
                    currentOrder.status = delOrder.status;
                    isRealActiveOrder = true;
                }
            } else {
                currentOrder = null;
                await clearRepCurrentOrder(repId);
            }
        }

        if (!currentOrder || !currentOrder.orderId) {
            const { Order } = require('../middlewares/Order');

            const activeDeliveryOrder = await Order.findOne({
                representativeId: rep._id,
                status: { $in: ACTIVE_STATUSES },
                isBusinessOrder: { $ne: true },
                orderCategory: { $ne: 'business' },
            }).select('_id orderId status').lean();

            if (activeDeliveryOrder) {
                const displayNum = activeDeliveryOrder.orderId || activeDeliveryOrder._id;
                currentOrder = {
                    orderId: String(displayNum),
                    status: activeDeliveryOrder.status,
                    type: 'delivery',
                };
                await setRepCurrentOrder(repId, currentOrder);
                isRealActiveOrder = true;
            } else {
                currentOrder = null;
                await clearRepCurrentOrder(repId);
            }
        }

        // Detect single current shift for this rep
        const { shift, referenceDateStr } = await detectCurrentShift(rep._id);

        const attendance = await AttendanceRecord.findOne({
            representativeId: rep._id,
            dateStr: referenceDateStr,
        }).select('manualCheckInAt manualCheckOutAt status').lean();

        const isFresh = Boolean(appStateObj && appStateObj.lastSeen && (nowTs - appStateObj.lastSeen < 180000));
        const isOnline = Boolean(appStateObj && appStateObj.state === 'open' && isFresh);
        const hasOrder = Boolean(currentOrder && currentOrder.orderId && isRealActiveOrder);

        if (isOnline) onlineCount++;
        if (hasOrder) onOrderCount++;
        if (!isOnline && shift) offlineInShiftCount++;

        const rawLastSeen = appStateObj?.lastSeen || attendance?.manualCheckOutAt || rep.lastLocation?.updatedAt || attendance?.manualCheckInAt || null;

        liveReps.push({
            representative: {
                id: rep._id,
                name: `${rep.firstName || ''} ${rep.lastName || ''}`.trim() || 'مندوب',
                email: rep.email,
                phone: rep.phone,
                profileImage: rep.profileImage,
                isAvailable: rep.isAvailable,
                vehicleNumber: rep.vehicleNumber,
                vehicleModel: rep.vehicleModel,
            },
            appState: isOnline ? 'open' : 'closed',
            lastSeen: rawLastSeen,
            currentShift: shift ? {
                id: shift._id,
                name: shift.name,
                startTime: shift.startTime,
                endTime: shift.endTime,
                crossesMidnight: shift.crossesMidnight,
            } : null,
            currentOrder: hasOrder ? currentOrder : null,
            lastLocation: rep.lastLocation || null,
            session: sessionObj || null,
            attendance: attendance ? {
                manualCheckInAt: attendance.manualCheckInAt || null,
                manualCheckOutAt: attendance.manualCheckOutAt || null,
                status: attendance.status || null,
            } : null,
        });
    }

    const dashboard = {
        summary: {
            totalRepresentatives: reps.length,
            onlineCount,
            onOrderCount,
            offlineInShiftCount,
            updatedAt: new Date(),
        },
        representatives: liveReps,
    };

    await cacheLiveDashboard(dashboard);
    res.json(dashboard);
});

/**
 * Get Single Representative Live Details
 * GET /api/hr/tracking/:repId
 */
const getRepLiveDetails = expressAsyncHandler(async (req, res) => {
    const { repId } = req.params;
    const rep = await User.findById(repId).select('-password').lean();

    if (!rep) {
        return res.status(404).json({ message: 'Representative not found' });
    }

    const { shift, referenceDateStr } = await detectCurrentShift(repId);
    const appStateObj = await getRepAppState(repId);
    const sessionObj = await getRepSession(repId);
    const currentOrder = await getRepCurrentOrder(repId);

    const todayAttendance = await AttendanceRecord.findOne({
        representativeId: repId,
        dateStr: referenceDateStr,
    }).populate('shiftId');

    res.json({
        representative: rep,
        currentShift: shift,
        appState: appStateObj ? appStateObj.state : 'closed',
        lastSeen: appStateObj ? appStateObj.lastSeen : null,
        session: sessionObj,
        currentOrder,
        todayAttendance,
    });
});

/**
 * Get Representative Activity Timeline
 * GET /api/hr/tracking/:repId/timeline
 */
const getRepTimeline = expressAsyncHandler(async (req, res) => {
    const { repId } = req.params;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 50;

    const filter = { representativeId: repId };
    if (req.query.dateStr) filter.dateStr = req.query.dateStr;
    if (req.query.eventType) filter.eventType = req.query.eventType;

    const logs = await RepActivityLog.find(filter)
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean();

    const total = await RepActivityLog.countDocuments(filter);

    res.json({
        logs,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
        },
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. REPORTS & CALENDAR FILTERING (Admin)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Helper function to generate array of date strings for a given month/year
 */
function getDatesInMonth(year, month) {
    const dates = [];
    const daysInMonth = new Date(year, month, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
        const dStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        dates.push(dStr);
    }
    return dates;
}

async function getRepCompletedOrdersCountMap(repId, dateStrings) {
    const ordersMap = new Map();
    if (!repId || !dateStrings || dateStrings.length === 0) return ordersMap;

    try {
        const sortedDates = [...dateStrings].sort();
        const startDateStr = sortedDates[0];
        const endDateStr = sortedDates[sortedDates.length - 1];

        const minDate = new Date(`${startDateStr}T00:00:00.000+03:00`);
        const maxDate = new Date(`${endDateStr}T23:59:59.999+03:00`);

        const repIdStr = String(repId);
        const repIdObj = mongoose.Types.ObjectId.isValid(repIdStr) ? new mongoose.Types.ObjectId(repIdStr) : null;

        const repMatch = repIdObj
            ? { $in: [repIdStr, repIdObj] }
            : repIdStr;

        const completedOrders = await Order.find({
            representativeId: repMatch,
            status: { $in: ['completed', 'delivered'] },
            updatedAt: { $gte: minDate, $lte: maxDate }
        }).select('updatedAt dateStr').lean();

        for (const order of completedOrders) {
            let orderDateStr = order.dateStr;
            if (!orderDateStr && order.updatedAt) {
                orderDateStr = formatDateStr(order.updatedAt);
            }
            if (orderDateStr) {
                ordersMap.set(orderDateStr, (ordersMap.get(orderDateStr) || 0) + 1);
            }
        }
    } catch (err) {
        console.error('[getRepCompletedOrdersCountMap] Error:', err.message);
    }
    return ordersMap;
}

function formatRecordToCard(dateStr, rec, liveCompletedCount = 0) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d));
    const dayNames = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    const dayName = dayNames[dateObj.getUTCDay() || 0];

    const finalOrdersDelivered = Math.max(rec?.ordersDelivered || 0, liveCompletedCount || 0);

    if (rec) {
        const isActuallyPresent = Boolean(rec.isManualCheckIn || rec.manualCheckInAt);
        const resolvedStatus = isActuallyPresent ? (rec.status === 'absent' ? 'present' : rec.status) : 'absent';

        return {
            dateStr,
            dayName,
            dayNumber: d,
            status: resolvedStatus,
            isManualCheckIn: isActuallyPresent,
            manualCheckInAt: rec.manualCheckInAt || null,
            manualCheckInLocation: rec.manualCheckInLocation || null,
            manualCheckOutAt: rec.manualCheckOutAt || null,
            totalOnlineMinutes: rec.totalOnlineMinutes || 0,
            ordersDelivered: finalOrdersDelivered,
            shift: rec.shiftId ? { name: rec.shiftId.name, startTime: rec.shiftId.startTime, endTime: rec.shiftId.endTime } : null,
            notes: rec.notes || '',
            recordId: rec._id,
            isPlaceholder: false,
        };
    }

    return {
        dateStr,
        dayName,
        dayNumber: d,
        status: 'absent',
        isManualCheckIn: false,
        manualCheckInAt: null,
        manualCheckInLocation: null,
        manualCheckOutAt: null,
        totalOnlineMinutes: 0,
        ordersDelivered: finalOrdersDelivered,
        shift: null,
        notes: '',
        recordId: null,
        isPlaceholder: true,
    };
}

/**
 * Representative Calendar Report (Daily, Weekly, Monthly, Custom)
 * GET /api/hr/reports/rep/:repId
 */
const getRepReport = expressAsyncHandler(async (req, res) => {
    const { repId } = req.params;
    const view = req.query.view || 'monthly';
    const now = new Date();

    const cairoTodayStr = formatDateStr(now);
    const [cairoYear, cairoMonth] = cairoTodayStr.split('-').map(Number);

    const year = parseInt(req.query.year, 10) || cairoYear;
    const month = parseInt(req.query.month, 10) || cairoMonth;

    const rep = await User.findById(repId).select('firstName lastName phone profileImage').lean();
    if (!rep) {
        return res.status(404).json({ message: 'Representative not found' });
    }

    if (view === 'monthly') {
        const dateStrings = getDatesInMonth(year, month);
        const monthPattern = `^${year}-${String(month).padStart(2, '0')}`;
        const records = await AttendanceRecord.find({
            representativeId: repId,
            $or: [
                { year, month },
                { dateStr: { $regex: monthPattern } }
            ]
        }).populate('shiftId').lean();

        const recordMap = new Map();
        records.forEach(r => recordMap.set(r.dateStr, r));

        const ordersMap = await getRepCompletedOrdersCountMap(repId, dateStrings);
        const dailyCards = dateStrings.map(dStr => formatRecordToCard(dStr, recordMap.get(dStr), ordersMap.get(dStr) || 0));

        records.forEach(r => {
            const liveCount = ordersMap.get(r.dateStr) || 0;
            if (liveCount > (r.ordersDelivered || 0)) {
                AttendanceRecord.updateOne({ _id: r._id }, { $set: { ordersDelivered: liveCount } }).catch(() => {});
            }
        });

        return res.json({
            representative: rep,
            view: 'monthly',
            month,
            year,
            totalDays: dailyCards.length,
            dailyCards,
            records,
        });
    }

    if (view === 'weekly') {
        const [cy, cm, cd] = cairoTodayStr.split('-').map(Number);
        const cairoDateObj = new Date(Date.UTC(cy, cm - 1, cd));
        const dayOfWeek = cairoDateObj.getUTCDay(); // 0 is Sun, 6 is Sat
        const diffToSat = (dayOfWeek + 1) % 7;
        const satDate = new Date(cairoDateObj);
        satDate.setUTCDate(cairoDateObj.getUTCDate() - diffToSat);

        const weekDates = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(satDate);
            d.setUTCDate(satDate.getUTCDate() + i);
            weekDates.push(formatDateStr(d));
        }

        const records = await AttendanceRecord.find({
            representativeId: repId,
            dateStr: { $in: weekDates }
        }).populate('shiftId').lean();

        const recordMap = new Map();
        records.forEach(r => recordMap.set(r.dateStr, r));

        const ordersMap = await getRepCompletedOrdersCountMap(repId, weekDates);
        const dailyCards = weekDates.map(dStr => formatRecordToCard(dStr, recordMap.get(dStr), ordersMap.get(dStr) || 0));

        records.forEach(r => {
            const liveCount = ordersMap.get(r.dateStr) || 0;
            if (liveCount > (r.ordersDelivered || 0)) {
                AttendanceRecord.updateOne({ _id: r._id }, { $set: { ordersDelivered: liveCount } }).catch(() => {});
            }
        });

        return res.json({
            representative: rep,
            view: 'weekly',
            dateStr: cairoTodayStr,
            totalDays: dailyCards.length,
            dailyCards,
            records,
        });
    }

    if (view === 'daily') {
        const dateStr = req.query.date || cairoTodayStr;
        const record = await AttendanceRecord.findOne({
            representativeId: repId,
            dateStr,
        }).populate('shiftId').lean();

        const logs = await RepActivityLog.find({
            representativeId: repId,
            dateStr,
        }).sort({ timestamp: 1 }).lean();

        const ordersMap = await getRepCompletedOrdersCountMap(repId, [dateStr]);
        const liveCount = ordersMap.get(dateStr) || 0;
        const dailyCard = formatRecordToCard(dateStr, record, liveCount);

        if (record && liveCount > (record.ordersDelivered || 0)) {
            AttendanceRecord.updateOne({ _id: record._id }, { $set: { ordersDelivered: liveCount } }).catch(() => {});
        }

        return res.json({
            representative: rep,
            view: 'daily',
            dateStr,
            record: record || null,
            dailyCards: [dailyCard],
            records: record ? [record] : [],
            logs,
        });
    }

    if (view === 'custom') {
        let { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            const daysInMonth = new Date(year, month, 0).getDate();
            startDate = startDate || `${year}-${String(month).padStart(2, '0')}-01`;
            endDate = endDate || `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
        }

        const records = await AttendanceRecord.find({
            representativeId: repId,
            dateStr: { $gte: startDate, $lte: endDate },
        }).populate('shiftId').sort({ dateStr: 1 }).lean();

        const recordMap = new Map();
        records.forEach(r => recordMap.set(r.dateStr, r));

        const dateStrings = [];
        let currDate = new Date(startDate);
        const lastDate = new Date(endDate);
        while (currDate <= lastDate) {
            dateStrings.push(formatDateStr(currDate));
            currDate.setDate(currDate.getDate() + 1);
        }

        const ordersMap = await getRepCompletedOrdersCountMap(repId, dateStrings);
        const dailyCards = dateStrings.map(dStr => formatRecordToCard(dStr, recordMap.get(dStr), ordersMap.get(dStr) || 0));

        records.forEach(r => {
            const liveCount = ordersMap.get(r.dateStr) || 0;
            if (liveCount > (r.ordersDelivered || 0)) {
                AttendanceRecord.updateOne({ _id: r._id }, { $set: { ordersDelivered: liveCount } }).catch(() => {});
            }
        });

        return res.json({
            representative: rep,
            view: 'custom',
            startDate,
            endDate,
            totalDays: dailyCards.length,
            dailyCards,
            records,
        });
    }

    return res.status(400).json({ message: 'Invalid view parameter. Allowed: daily, weekly, monthly, custom' });
});

/**
 * HR Global Reports Summary (All reps)
 * GET /api/hr/reports/summary
 */
const getReportsSummary = expressAsyncHandler(async (req, res) => {
    const cairoTodayStr = formatDateStr(new Date());
    const [cairoYear, cairoMonth] = cairoTodayStr.split('-').map(Number);

    const year = parseInt(req.query.year, 10) || cairoYear;
    const month = parseInt(req.query.month, 10) || cairoMonth;

    const summary = await AttendanceRecord.aggregate([
        { $match: { year, month } },
        {
            $group: {
                _id: '$representativeId',
                totalDaysPresent: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'present'] }, { $or: [{ $eq: ['$isManualCheckIn', true] }, { $ne: ['$manualCheckInAt', null] }] }] }, 1, 0] } },
                totalManualCheckIns: { $sum: { $cond: ['$isManualCheckIn', 1, 0] } },
                totalOnlineMinutes: { $sum: '$totalOnlineMinutes' },
                totalOrdersDelivered: { $sum: '$ordersDelivered' },
            },
        },
        {
            $lookup: {
                from: 'users',
                localField: '_id',
                foreignField: '_id',
                as: 'rep',
            },
        },
        { $unwind: '$rep' },
        {
            $project: {
                repId: '$_id',
                repName: { $concat: ['$rep.firstName', ' ', '$rep.lastName'] },
                phone: '$rep.phone',
                totalDaysPresent: 1,
                totalManualCheckIns: 1,
                totalOnlineMinutes: 1,
                totalOnlineHours: { $round: [{ $divide: ['$totalOnlineMinutes', 60] }, 1] },
                totalOrdersDelivered: 1,
            },
        },
    ]);

    res.json({
        year,
        month,
        summary,
    });
});

/**
 * Manual Log Deletion for Single Rep (Admin Only)
 * DELETE /api/hr/reports/rep/:repId/logs
 */
const deleteRepLogs = expressAsyncHandler(async (req, res) => {
    const { repId } = req.params;
    const { before } = req.query;

    const filter = { representativeId: repId };
    if (before) filter.dateStr = { $lt: before };

    const logsDeleted = await RepActivityLog.deleteMany(filter);
    const recordsDeleted = await AttendanceRecord.deleteMany(filter);

    res.json({
        message: 'Representative logs deleted successfully',
        repId,
        logsDeletedCount: logsDeleted.deletedCount,
        recordsDeletedCount: recordsDeleted.deletedCount,
    });
});

/**
 * Bulk Manual Log Deletion (Admin Only)
 * DELETE /api/hr/reports/logs
 */
const deleteBulkLogs = expressAsyncHandler(async (req, res) => {
    const { before } = req.query;

    if (!before) {
        return res.status(400).json({ message: 'query parameter "before" (YYYY-MM-DD) is required for safety' });
    }

    const filter = { dateStr: { $lt: before } };

    const logsDeleted = await RepActivityLog.deleteMany(filter);
    const recordsDeleted = await AttendanceRecord.deleteMany(filter);

    res.json({
        message: `Logs prior to ${before} deleted successfully`,
        logsDeletedCount: logsDeleted.deletedCount,
        recordsDeletedCount: recordsDeleted.deletedCount,
    });
});

/**
 * Admin: Force Clear Representative's Cached State (Redis)
 * Used when a rep shows as 'busy' but has no active order.
 * DELETE /api/hr/tracking/:repId/clear-state
 */
const clearRepCachedState = expressAsyncHandler(async (req, res) => {
    const { repId } = req.params;

    const rep = await User.findById(repId).select('firstName lastName').lean();
    if (!rep) {
        return res.status(404).json({ message: 'Representative not found' });
    }

    // Clear ALL cached states for this rep
    await clearRepCurrentOrder(repId);
    await clearRepSession(repId);
    await invalidateLiveDashboard();

    logger.info(`[HR Admin] Cleared cached state for rep ${repId} (${rep.firstName} ${rep.lastName})`);

    res.json({
        message: `تم مسح الحالة المؤقتة للمندوب ${rep.firstName} ${rep.lastName} بنجاح`,
        repId,
        clearedAt: new Date(),
    });
});

const updateAttendanceNotes = expressAsyncHandler(async (req, res) => {
    const { recordId } = req.params;
    const { notes } = req.body;

    const record = await AttendanceRecord.findByIdAndUpdate(
        recordId,
        { notes: notes || '' },
        { new: true }
    );

    if (!record) {
        return res.status(404).json({ message: 'Attendance record not found' });
    }

    res.json({ message: 'Notes updated successfully', record });
});

module.exports = {
    // Shift CRUD
    createShift,
    getShifts,
    updateShift,
    deleteShift,
    assignRepsToShift,
    unassignRepFromShift,
    getShiftCoverage,
    // Attendance Manual
    manualCheckIn,
    manualCheckOut,
    getMyTodayAttendance,
    // Attendance Automatic
    appOpen,
    appClose,
    heartbeat,
    // Live Tracking
    getLiveTracking,
    getRepLiveDetails,
    getRepTimeline,
    // Reports & Deletion
    getRepReport,
    getReportsSummary,
    deleteRepLogs,
    deleteBulkLogs,
    updateAttendanceNotes,
    adminOverrideAttendance,
    // Admin Tools
    clearRepCachedState,
};
