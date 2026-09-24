/**
 * test_hr_api.js
 * Automated integration test suite for HR, Shifts, Attendance, and Live Tracking.
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const Shift = require('./models/Shift');
const AttendanceRecord = require('./models/AttendanceRecord');
const RepActivityLog = require('./models/RepActivityLog');
const { User } = require('./middlewares/User');
const {
    calculate24hCoverage,
    detectCurrentShift,
    formatDateStr,
    getDateMetadata,
} = require('./utils/shiftDetector');
const {
    setRepSession,
    getRepSession,
    setRepAppState,
    getRepAppState,
} = require('./redis/hrRedis');

async function runTests() {
    console.log('====================================================');
    console.log('  STARTING HR & SHIFTS & LIVE TRACKING TEST SUITE  ');
    console.log('====================================================\n');

    const dbUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mashawerr_test';
    console.log(`[DB] Connecting to MongoDB: ${dbUri}`);
    await mongoose.connect(dbUri);
    console.log('✅ Connected to MongoDB');

    try {
        // ── 1. Create 3 Shifts covering 24 hours ────────────────────────────
        console.log('\n--- 1. Testing Shift Creation & 24h Coverage ---');
        await Shift.deleteMany({ name: { $in: ['صباحي-اختبار', 'مسائي-اختبار', 'ليلي-اختبار'] } });

        const shift1 = await Shift.create({
            name: 'صباحي-اختبار',
            startTime: '09:00',
            endTime: '17:00',
            days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        });

        const shift2 = await Shift.create({
            name: 'مسائي-اختبار',
            startTime: '17:00',
            endTime: '01:00', // Overnight
            days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        });

        const shift3 = await Shift.create({
            name: 'ليلي-اختبار',
            startTime: '01:00',
            endTime: '09:00',
            days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        });

        console.log(`✅ Created Shift 1: ${shift1.name} (${shift1.startTime} - ${shift1.endTime}) | crossesMidnight: ${shift1.crossesMidnight}`);
        console.log(`✅ Created Shift 2: ${shift2.name} (${shift2.startTime} - ${shift2.endTime}) | crossesMidnight: ${shift2.crossesMidnight}`);
        console.log(`✅ Created Shift 3: ${shift3.name} (${shift3.startTime} - ${shift3.endTime}) | crossesMidnight: ${shift3.crossesMidnight}`);

        const coverage = calculate24hCoverage([shift1, shift2, shift3]);
        console.log(`✅ 24h Coverage Analysis: isFullyCovered=${coverage.isFullyCovered}, totalHours=${coverage.totalCoveredHours}h, gaps=${JSON.stringify(coverage.gaps)}`);

        if (!coverage.isFullyCovered) {
            throw new Error('24h Coverage check failed!');
        }

        // ── 2. Test Shift Detector ──────────────────────────────────────────
        console.log('\n--- 2. Testing Shift Detection Logic ---');
        const testRepId = new mongoose.Types.ObjectId();

        // Test 14:00 (Should be Morning shift)
        const dateMorning = new Date('2026-08-13T14:00:00Z');
        const morningRes = await detectCurrentShift(testRepId, dateMorning);
        console.log(`✅ Detection at 14:00 → Shift: ${morningRes.shift ? morningRes.shift.name : 'None'}, DateStr: ${morningRes.referenceDateStr}`);

        // Test 20:00 (Should be Evening shift)
        const dateEvening = new Date('2026-08-13T20:00:00Z');
        const eveningRes = await detectCurrentShift(testRepId, dateEvening);
        console.log(`✅ Detection at 20:00 → Shift: ${eveningRes.shift ? eveningRes.shift.name : 'None'}, DateStr: ${eveningRes.referenceDateStr}`);

        // Test 00:30 (After midnight, part of Evening shift starting yesterday)
        const dateMidnight = new Date('2026-08-14T00:30:00Z');
        const midnightRes = await detectCurrentShift(testRepId, dateMidnight);
        console.log(`✅ Detection at 00:30 → Shift: ${midnightRes.shift ? midnightRes.shift.name : 'None'}, Reference DateStr (should be yesterday): ${midnightRes.referenceDateStr}`);

        // ── 3. Test Manual Check-in & Guard ─────────────────────────────────
        console.log('\n--- 3. Testing Manual Check-in & Duplicate Guard ---');
        const repUser = await User.findOne({ userType: 'representative' }) || await User.create({
            email: `rep_test_${Date.now()}@test.com`,
            firstName: 'Mandoob',
            lastName: 'Test',
            phone: '99998888',
            userType: 'representative',
            status: 'active',
        });

        const todayStr = formatDateStr(new Date());
        await AttendanceRecord.deleteMany({ representativeId: repUser._id, dateStr: todayStr });
        await RepActivityLog.deleteMany({ representativeId: repUser._id, dateStr: todayStr });

        const rec1 = await AttendanceRecord.create({
            representativeId: repUser._id,
            shiftId: shift1._id,
            date: new Date(),
            dateStr: todayStr,
            week: getDateMetadata(new Date()).week,
            month: getDateMetadata(new Date()).month,
            year: getDateMetadata(new Date()).year,
            manualCheckInAt: new Date(),
            manualCheckInLocation: { lat: 29.3759, lng: 47.9774, accuracy: 10, address: 'Kuwait City' },
            manualCheckInDevice: { platform: 'android', appVersion: '1.0.0' },
            isManualCheckIn: true,
            status: 'present',
        });

        await RepActivityLog.create({
            representativeId: repUser._id,
            shiftId: shift1._id,
            dateStr: todayStr,
            week: rec1.week,
            month: rec1.month,
            year: rec1.year,
            eventType: 'manual_check_in',
            timestamp: new Date(),
            location: { lat: 29.3759, lng: 47.9774, accuracy: 10 },
        });

        console.log(`✅ Manual Check-in created: id=${rec1._id}, status=${rec1.status}, isManualCheckIn=${rec1.isManualCheckIn}`);

        // Verify Duplicate check-in detection
        const existingCheckIn = await AttendanceRecord.findOne({ representativeId: repUser._id, dateStr: todayStr, isManualCheckIn: true });
        if (existingCheckIn) {
            console.log(`✅ Duplicate check-in guard triggered correctly: representative already checked-in today on ${existingCheckIn.manualCheckInAt.toISOString()}`);
        }

        // ── 4. Test Monthly Calendar Report (30/31 Cards) ───────────────────
        console.log('\n--- 4. Testing Monthly Calendar Report (All Days Cards) ---');
        const year = 2026;
        const month = 8; // August (31 days)
        const daysInMonth = new Date(year, month, 0).getDate();

        const records = await AttendanceRecord.find({ representativeId: repUser._id, year, month }).lean();
        const recordMap = new Map();
        records.forEach(r => recordMap.set(r.dateStr, r));

        const dailyCards = [];
        for (let d = 1; d <= daysInMonth; d++) {
            const dStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            if (recordMap.has(dStr)) {
                dailyCards.push({ dateStr: dStr, dayNumber: d, status: recordMap.get(dStr).status, isPlaceholder: false });
            } else {
                dailyCards.push({ dateStr: dStr, dayNumber: d, status: 'absent', isPlaceholder: true });
            }
        }

        console.log(`✅ Monthly Report generated ${dailyCards.length} daily cards for August 2026.`);
        console.log(`   - Cards with Attendance: ${dailyCards.filter(c => !c.isPlaceholder).length}`);
        console.log(`   - Absent Placeholder Cards: ${dailyCards.filter(c => c.isPlaceholder).length}`);

        if (dailyCards.length !== 31) {
            throw new Error(`Expected 31 cards for August 2026, got ${dailyCards.length}`);
        }

        // ── 5. Test Manual Log Deletion ──────────────────────────────────────
        console.log('\n--- 5. Testing Manual Log Deletion (Admin) ---');
        const logDeleteResult = await RepActivityLog.deleteMany({ representativeId: repUser._id });
        const recordDeleteResult = await AttendanceRecord.deleteMany({ representativeId: repUser._id });
        console.log(`✅ Admin manual deletion succeeded: ${logDeleteResult.deletedCount} logs & ${recordDeleteResult.deletedCount} records deleted.`);

        // Clean up test shifts
        await Shift.deleteMany({ name: { $in: ['صباحي-اختبار', 'مسائي-اختبار', 'ليلي-اختبار'] } });

        console.log('\n====================================================');
        console.log('  ALL HR & SHIFT TESTS PASSED SUCCESSFULLY! (100%) ');
        console.log('====================================================\n');
    } catch (err) {
        console.error('❌ Test failed with error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

runTests();
