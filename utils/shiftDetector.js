/**
 * utils/shiftDetector.js
 * Utility module for detecting active shifts and calculating date metadata.
 */

const Shift = require('../models/Shift');
const { getCachedActiveShifts, cacheActiveShifts } = require('../redis/hrRedis');
const logger = require('./logger');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Format a Date object into YYYY-MM-DD string in Egypt (Africa/Cairo) timezone.
 * @param {Date|string|number} [date]
 * @returns {string}
 */
function formatDateStr(date = new Date()) {
    const d = new Date(date);
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return formatter.format(d);
}

/**
 * Calculate ISO Week number for a given date
 * @param {Date} date
 * @returns {number}
 */
function getIsoWeek(date) {
    const tmpDate = new Date(date.valueOf());
    const dayNum = (date.getDay() + 6) % 7;
    tmpDate.setDate(tmpDate.getDate() - dayNum + 3);
    const firstThursday = tmpDate.valueOf();
    tmpDate.setMonth(0, 1);
    if (tmpDate.getDay() !== 4) {
        tmpDate.setMonth(0, 1 + ((4 - tmpDate.getDay() + 7) % 7));
    }
    return 1 + Math.round((firstThursday - tmpDate.valueOf()) / 604800000);
}

/**
 * Return complete date metadata object from Date in Egypt (Africa/Cairo) timezone
 * @param {Date|string|number} [date]
 * @returns {{ date: Date, dateStr: string, week: number, month: number, year: number }}
 */
function getDateMetadata(date = new Date()) {
    const dateStr = formatDateStr(date);
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day));

    return {
        date: d,
        dateStr,
        week: getIsoWeek(d),
        month,
        year,
    };
}

/**
 * Get active shifts from Redis or MongoDB
 * @returns {Promise<Array>}
 */
async function getActiveShifts() {
    try {
        const cached = await getCachedActiveShifts();
        if (cached && Array.isArray(cached) && cached.length > 0) {
            return cached;
        }

        const shifts = await Shift.find({ isActive: true }).lean();
        if (shifts && shifts.length > 0) {
            await cacheActiveShifts(shifts);
        }
        return shifts || [];
    } catch (err) {
        logger.error(`[shiftDetector] getActiveShifts error: ${err.message}`);
        return await Shift.find({ isActive: true }).lean();
    }
}

/**
 * Detect the active shift for a given representative at a specific time
 * @param {string|mongoose.Types.ObjectId} repId
 * @param {Date} [currentTime]
 * @returns {Promise<{ shift: Object|null, referenceDateStr: string, meta: Object }>}
 */
async function detectCurrentShift(repId, currentTime = new Date()) {
    const now = new Date(currentTime);
    
    // Evaluate in Cairo/Egypt timezone (Africa/Cairo)
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Africa/Cairo',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    });
    const parts = formatter.formatToParts(now);
    let curHours = 0, curMins = 0;
    for (const p of parts) {
        if (p.type === 'hour') curHours = parseInt(p.value, 10) % 24;
        if (p.type === 'minute') curMins = parseInt(p.value, 10);
    }
    const curMinutes = curHours * 60 + curMins;

    const cairoTodayStr = formatDateStr(now);
    const [y, m, d] = cairoTodayStr.split('-').map(Number);
    const cairoTodayDate = new Date(Date.UTC(y, m - 1, d));

    const cairoYesterdayDate = new Date(cairoTodayDate);
    cairoYesterdayDate.setUTCDate(cairoYesterdayDate.getUTCDate() - 1);
    const cairoYesterdayStr = formatDateStr(cairoYesterdayDate);

    const todayName = now.toLocaleDateString('en-US', { timeZone: 'Africa/Cairo', weekday: 'short' });
    const yesterdayName = cairoYesterdayDate.toLocaleDateString('en-US', { timeZone: 'Africa/Cairo', weekday: 'short' });

    const shifts = await getActiveShifts();
    const repIdStr = repId ? repId.toString() : null;

    // Filter shifts assigned to this representative first
    const repShifts = repIdStr
        ? shifts.filter(s => s.representativeIds && s.representativeIds.map(id => id.toString()).includes(repIdStr))
        : [];

    const globalShifts = shifts.filter(s => !s.representativeIds || s.representativeIds.length === 0);

    const matchShift = (shift) => {
        const [startH, startM] = shift.startTime.split(':').map(Number);
        const [endH, endM] = shift.endTime.split(':').map(Number);

        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;

        const isCrossesMidnight = shift.crossesMidnight || (endMinutes < startMinutes);

        if (!isCrossesMidnight) {
            if (curMinutes >= startMinutes && curMinutes < endMinutes) {
                if (!shift.days || shift.days.length === 0 || shift.days.includes(todayName)) {
                    return {
                        shift,
                        referenceDateStr: cairoTodayStr,
                        meta: getDateMetadata(cairoTodayDate),
                    };
                }
            }
        } else {
            if (curMinutes >= startMinutes) {
                if (!shift.days || shift.days.length === 0 || shift.days.includes(todayName)) {
                    return {
                        shift,
                        referenceDateStr: cairoTodayStr,
                        meta: getDateMetadata(cairoTodayDate),
                    };
                }
            }
            if (curMinutes < endMinutes) {
                if (!shift.days || shift.days.length === 0 || shift.days.includes(yesterdayName)) {
                    return {
                        shift,
                        referenceDateStr: cairoYesterdayStr,
                        meta: getDateMetadata(cairoYesterdayDate),
                    };
                }
            }
        }
        return null;
    };

    // When repId is provided, ONLY evaluate shifts assigned to this representative
    if (repIdStr) {
        // 1. Check if representative has an active shift matching current time
        for (const shift of repShifts) {
            const match = matchShift(shift);
            if (match) return match;
        }

        // 2. Fallback: If representative is assigned to shifts, return the first one for dashboard view
        if (repShifts.length > 0) {
            return {
                shift: repShifts[0],
                referenceDateStr: cairoTodayStr,
                meta: getDateMetadata(cairoTodayDate),
            };
        }

        // Representative has no assigned shifts at all
        return {
            shift: null,
            referenceDateStr: cairoTodayStr,
            meta: getDateMetadata(cairoTodayDate),
        };
    }

    // If no specific representative is queried, check global shifts
    for (const shift of globalShifts) {
        const match = matchShift(shift);
        if (match) return match;
    }

    return {
        shift: null,
        referenceDateStr: cairoTodayStr,
        meta: getDateMetadata(cairoTodayDate),
    };
}

/**
 * Calculate 24-hour shift coverage across all active shifts
 * Returns covered intervals and uncovered gaps
 * @param {Array} shifts
 * @returns {{ isFullyCovered: boolean, totalCoveredHours: number, gaps: Array, coveredSlots: Array }}
 */
function calculate24hCoverage(shifts) {
    if (!shifts || shifts.length === 0) {
        return {
            isFullyCovered: false,
            totalCoveredHours: 0,
            gaps: [{ start: '00:00', end: '24:00' }],
            coveredSlots: [],
        };
    }

    // Create 1440 minute array (24 hours * 60 mins)
    const minutes = new Array(1440).fill(false);

    for (const shift of shifts) {
        if (!shift.isActive) continue;

        const [startH, startM] = shift.startTime.split(':').map(Number);
        const [endH, endM] = shift.endTime.split(':').map(Number);

        const startMin = startH * 60 + startM;
        const endMin = endH * 60 + endM;

        if (endMin > startMin) {
            for (let m = startMin; m < endMin; m++) minutes[m] = true;
        } else if (endMin < startMin || shift.crossesMidnight) {
            for (let m = startMin; m < 1440; m++) minutes[m] = true;
            for (let m = 0; m < endMin; m++) minutes[m] = true;
        } else {
            // 24-hour shift
            for (let m = 0; m < 1440; m++) minutes[m] = true;
        }
    }

    let coveredCount = 0;
    const gaps = [];
    const coveredSlots = [];

    let currentInGap = null;
    let currentInCovered = null;

    for (let m = 0; m < 1440; m++) {
        if (minutes[m]) {
            coveredCount++;
            if (currentInGap !== null) {
                gaps.push({
                    start: minToTimeString(currentInGap),
                    end: minToTimeString(m),
                });
                currentInGap = null;
            }
            if (currentInCovered === null) {
                currentInCovered = m;
            }
        } else {
            if (currentInCovered !== null) {
                coveredSlots.push({
                    start: minToTimeString(currentInCovered),
                    end: minToTimeString(m),
                });
                currentInCovered = null;
            }
            if (currentInGap === null) {
                currentInGap = m;
            }
        }
    }

    if (currentInGap !== null) {
        gaps.push({ start: minToTimeString(currentInGap), end: '24:00' });
    }
    if (currentInCovered !== null) {
        coveredSlots.push({ start: minToTimeString(currentInCovered), end: '24:00' });
    }

    const totalCoveredHours = Math.round((coveredCount / 60) * 10) / 10;
    const isFullyCovered = coveredCount === 1440;

    return {
        isFullyCovered,
        totalCoveredHours,
        gaps,
        coveredSlots,
    };
}

function minToTimeString(m) {
    const h = String(Math.floor(m / 60)).padStart(2, '0');
    const min = String(m % 60).padStart(2, '0');
    return `${h}:${min}`;
}

/**
 * Helper to evaluate representative shift timing window:
 * - 15 minutes grace period after startTime to check in.
 * - Cannot check in before startTime.
 * - Auto absent if current time > startTime + 15 mins without check in.
 * - Cannot check out before endTime.
 */
function evaluateShiftTiming(shift, now = new Date()) {
    if (!shift || !shift.startTime || !shift.endTime) {
        return {
            hasShift: false,
            isBeforeShiftStart: false,
            isWithinCheckInWindow: true,
            isPastGracePeriod: false,
            isBeforeShiftEnd: true,
            isAfterShiftEnd: false,
        };
    }

    // Evaluate current time in Cairo/Egypt timezone (Africa/Cairo)
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Africa/Cairo',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    });
    const parts = formatter.formatToParts(now);
    let curHours = 0, curMins = 0;
    for (const p of parts) {
        if (p.type === 'hour') curHours = parseInt(p.value, 10) % 24;
        if (p.type === 'minute') curMins = parseInt(p.value, 10);
    }
    const currentTotalMinutes = curHours * 60 + curMins;

    const [startH, startM] = shift.startTime.split(':').map(Number);
    const [endH, endM] = shift.endTime.split(':').map(Number);

    const shiftStartMinutes = startH * 60 + startM;
    let shiftEndMinutes = endH * 60 + endM;

    const crossesMidnight = shift.crossesMidnight || (shiftEndMinutes < shiftStartMinutes);
    if (crossesMidnight) {
        shiftEndMinutes += 1440;
    }

    const graceLimitMinutes = shiftStartMinutes + 15;
    const checkoutGraceLimitMinutes = shiftEndMinutes + 90; // 1.5 hours (90 minutes) grace period after shift end

    let adjustedCurrentMinutes = currentTotalMinutes;
    if (crossesMidnight && currentTotalMinutes < shiftStartMinutes && currentTotalMinutes <= (shiftEndMinutes - 1440)) {
        adjustedCurrentMinutes += 1440;
    }

    const isBeforeShiftStart = adjustedCurrentMinutes < shiftStartMinutes;
    const isWithinCheckInWindow = adjustedCurrentMinutes >= shiftStartMinutes && adjustedCurrentMinutes <= graceLimitMinutes;
    const isPastGracePeriod = adjustedCurrentMinutes > graceLimitMinutes;
    const isBeforeShiftEnd = adjustedCurrentMinutes < shiftEndMinutes;
    const isAfterShiftEnd = adjustedCurrentMinutes >= shiftEndMinutes;
    const isWithinCheckoutGracePeriod = adjustedCurrentMinutes >= shiftEndMinutes && adjustedCurrentMinutes <= checkoutGraceLimitMinutes;
    const isPastCheckoutGracePeriod = adjustedCurrentMinutes > checkoutGraceLimitMinutes;

    return {
        hasShift: true,
        isBeforeShiftStart,
        isWithinCheckInWindow,
        isPastGracePeriod,
        isBeforeShiftEnd,
        isAfterShiftEnd,
        checkoutGraceLimitMinutes,
        isWithinCheckoutGracePeriod,
        isPastCheckoutGracePeriod,
        shiftStartMinutes,
        graceLimitMinutes,
        shiftEndMinutes,
        startTime: shift.startTime,
        endTime: shift.endTime,
    };
}

module.exports = {
    formatDateStr,
    getIsoWeek,
    getDateMetadata,
    detectCurrentShift,
    calculate24hCoverage,
    evaluateShiftTiming,
};
