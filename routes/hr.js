const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/verifytoken');
const { administrationOrAdmin } = require('../middlewares/authorize');
const {
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
} = require('../Controllers/hrController');

// ─── SHIFT MANAGEMENT (Admin & Administration) ───────────────────────────────
router.post('/shifts', administrationOrAdmin, createShift);
router.get('/shifts', administrationOrAdmin, getShifts);
router.get('/shifts/coverage', administrationOrAdmin, getShiftCoverage);
router.patch('/shifts/:id', administrationOrAdmin, updateShift);
router.put('/shifts/:id', administrationOrAdmin, updateShift);
router.delete('/shifts/:id', administrationOrAdmin, deleteShift);
router.post('/shifts/:id/assign', administrationOrAdmin, assignRepsToShift);
router.delete('/shifts/:id/assign/:repId', administrationOrAdmin, unassignRepFromShift);

// ─── ATTENDANCE (Manual - Rep settings) ───────────────────────────────────────
router.post('/attendance/manual-check-in', verifyToken, manualCheckIn);
router.post('/attendance/manual-check-out', verifyToken, manualCheckOut);
router.get('/attendance/my-today', verifyToken, getMyTodayAttendance);

// ─── ATTENDANCE (Automatic - Background lifecycle & heartbeat) ────────────────
router.post('/attendance/app-open', verifyToken, appOpen);
router.post('/attendance/app-close', verifyToken, appClose);
router.post('/attendance/heartbeat', verifyToken, heartbeat);

// ─── LIVE TRACKING (Admin & Administration) ───────────────────────────────────
router.get('/tracking/live', administrationOrAdmin, getLiveTracking);
router.get('/tracking/:repId', administrationOrAdmin, getRepLiveDetails);
router.get('/tracking/:repId/timeline', administrationOrAdmin, getRepTimeline);

// ─── REPORTS & CALENDAR FILTERING (Admin & Administration) ────────────────────
router.get('/reports/rep/:repId', verifyToken, getRepReport);
router.get('/reports/summary', administrationOrAdmin, getReportsSummary);
router.patch('/attendance/override', administrationOrAdmin, adminOverrideAttendance);
router.patch('/attendance/:recordId/notes', administrationOrAdmin, updateAttendanceNotes);

// ─── MANUAL DATA DELETION (Admin & Administration) ───────────────────────────
router.delete('/reports/rep/:repId/logs', administrationOrAdmin, deleteRepLogs);
router.delete('/reports/logs', administrationOrAdmin, deleteBulkLogs);

// ─── ADMIN TOOLS: Force-clear stale Redis state ───────────────────────────────
// Use when a rep shows as 'busy with order' but has no active order
router.delete('/tracking/:repId/clear-state', administrationOrAdmin, clearRepCachedState);

module.exports = router;
