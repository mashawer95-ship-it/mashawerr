/**
 * circuitBreaker.js
 * Simple Circuit Breaker pattern implementation for Google Routes API.
 * Prevents cascading failures and repeated API requests during Google outages.
 */

const logger = require('./logger');

class SimpleCircuitBreaker {
    constructor() {
        this.state = {};
        this.failureThreshold = parseInt(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD || '5', 10);
        this.recoveryMs = parseInt(process.env.CIRCUIT_BREAKER_RECOVERY_MS || '60000', 10);
    }

    isOpen(service = 'google') {
        const s = this.state[service];
        if (!s || s.status === 'closed') return false;
        if (s.status === 'open') {
            if (Date.now() - s.openedAt > this.recoveryMs) {
                s.status = 'half_open';
                logger.info(`[CB] ${service} → HALF_OPEN (Testing recovery)`);
                return false;
            }
            return true;
        }
        return false;
    }

    recordSuccess(service = 'google') {
        if (this.state[service]?.status === 'half_open' || this.state[service]?.status === 'open') {
            logger.info(`[CB] ${service} → CLOSED (Recovered standard operation)`);
        }
        this.state[service] = { failures: 0, status: 'closed' };
    }

    recordFailure(service = 'google') {
        const s = this.state[service] || { failures: 0, status: 'closed' };
        s.failures++;
        if (s.failures >= this.failureThreshold) {
            s.status = 'open';
            s.openedAt = Date.now();
            logger.error(`[CB] ${service} → OPEN after ${s.failures} consecutive failures`);
        }
        this.state[service] = s;
    }
}

const circuitBreaker = new SimpleCircuitBreaker();

module.exports = {
    SimpleCircuitBreaker,
    circuitBreaker,
};
