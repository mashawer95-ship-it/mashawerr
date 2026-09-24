/**
 * refreshQueue.js
 * A simple in-memory queue to limit concurrency of background tasks
 * (e.g., Google Routes API calls) to prevent Promise Storms.
 */

const logger = require('./logger');

class RefreshQueue {
    constructor(maxConcurrency = 20) {
        this.maxConcurrency = maxConcurrency;
        this.activeCount = 0;
        this.queue = [];
    }

    /**
     * Add a task to the queue.
     * @param {Function} task - An async function that returns a Promise.
     */
    push(task) {
        this.queue.push(task);
        this.processNext();
    }

    async processNext() {
        if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) {
            return;
        }

        this.activeCount++;
        const task = this.queue.shift();

        try {
            await task();
        } catch (error) {
            logger.error('[RefreshQueue] Task error:', error.message);
        } finally {
            this.activeCount--;
            this.processNext();
        }
    }
}

// Global singleton instance
const refreshQueue = new RefreshQueue(20);

module.exports = refreshQueue;
