/**
 * asyncHandler.js
 * Higher-order function wrapping async route handlers to forward unhandled errors to Express next().
 */

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
