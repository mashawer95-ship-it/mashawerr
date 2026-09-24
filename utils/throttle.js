/**
 * throttle.js
 * Per-key throttle and debounce utilities for controlling update rates.
 *
 * Used to:
 *  - Throttle driver broadcasts: max 1 broadcast per THROTTLE_MS per driver
 *  - Debounce Redis writes: batch rapid updates, write once after silence
 *
 * All state is in-process Maps. In a multi-instance cluster, each instance
 * manages its own connected drivers so this is sufficient (no cross-node state needed).
 */

/** Max broadcast frequency per driver (ms). Default: 1 per 1000ms (1 second). */
const THROTTLE_MS = Number(process.env.BROADCAST_THROTTLE_MS) || 1000;

/**
 * Per-driver last-broadcast timestamp.
 * Key: driverId (string), Value: Date.now()
 * @type {Map<string, number>}
 */
const lastBroadcastAt = new Map();

/**
 * Per-driver pending debounce timers for Redis writes.
 * Key: driverId, Value: NodeJS.Timeout
 * @type {Map<string, NodeJS.Timeout>}
 */
const debounceTimers = new Map();

/**
 * Check if a driver is within the throttle window.
 * Returns true if the update should be DROPPED (too frequent).
 *
 * @param {string} driverId
 * @returns {boolean} true = throttled (skip broadcast)
 */
function isThrottled(driverId) {
    const last = lastBroadcastAt.get(driverId);
    if (!last) return false;
    return (Date.now() - last) < THROTTLE_MS;
}

/**
 * Record that a broadcast just occurred for this driver.
 * @param {string} driverId
 */
function markBroadcast(driverId) {
    lastBroadcastAt.set(driverId, Date.now());
}

/**
 * Debounce a function call per driver key.
 * Only the last call within `delayMs` will execute.
 *
 * @param {string} driverId
 * @param {Function} fn - function to debounce
 * @param {number} [delayMs=1000]
 */
function debouncePerDriver(driverId, fn, delayMs = 1000) {
    const existing = debounceTimers.get(driverId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
        debounceTimers.delete(driverId);
        fn();
    }, delayMs);

    debounceTimers.set(driverId, timer);
}

/**
 * Clear all throttle/debounce state for a driver on disconnect.
 * Prevents memory leaks from long-lived Map entries.
 *
 * @param {string} driverId
 */
function clearDriverThrottleState(driverId) {
    lastBroadcastAt.delete(driverId);

    const timer = debounceTimers.get(driverId);
    if (timer) {
        clearTimeout(timer);
        debounceTimers.delete(driverId);
    }
}

/**
 * Get count of currently tracked drivers (for diagnostics).
 * @returns {number}
 */
function activeThrottleCount() {
    return lastBroadcastAt.size;
}

module.exports = {
    isThrottled,
    markBroadcast,
    debouncePerDriver,
    clearDriverThrottleState,
    activeThrottleCount,
    THROTTLE_MS,
};
