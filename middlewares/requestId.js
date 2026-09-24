/**
 * requestId.js
 * Express middleware that generates or propagates a unique X-Request-ID for every incoming request.
 * Useful for correlating logs and client error reporting in microservice/API architectures.
 */

const generateId = () => {
    try {
        const { randomUUID } = require('crypto');
        if (randomUUID) return randomUUID();
    } catch (_) {}
    return `req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
};

const requestId = (req, res, next) => {
    const existingId = req.headers['x-request-id'] || req.headers['x-correlation-id'];
    const id = existingId || generateId();
    req.id = id;
    res.setHeader('x-request-id', id);
    next();
};

module.exports = requestId;
