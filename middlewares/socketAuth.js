/**
 * socketAuth.js
 * JWT authentication middleware for Socket.IO connections.
 *
 * Verifies the ACCESS TOKEN (short-lived, 10 minutes).
 * The client must reconnect with a fresh access token after expiry.
 *
 * Usage (inside a Socket.IO namespace):
 *   namespace.use(socketAuthMiddleware);
 *
 * The middleware reads the JWT from:
 *   1. socket.handshake.auth.token   ← preferred (socket_io_client Flutter)
 *   2. socket.handshake.headers.authorization  (Bearer token)
 *   3. socket.handshake.query.token  (testing only)
 *
 * On success:  attaches decoded payload to socket.user
 * On failure:  calls next(new Error('Unauthorized')) → socket disconnects
 */

const jwt    = require('jsonwebtoken');
const logger = require('../utils/logger');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;

/**
 * Socket.IO middleware: verify Access Token and attach user to socket.
 *
 * @param {import('socket.io').Socket} socket
 * @param {Function} next
 */
function socketAuthMiddleware(socket, next) {
    // 1. Try auth.token (set by Flutter socket_io_client via setAuth)
    let token = socket.handshake.auth?.token;

    // 2. Fallback: Authorization header
    if (!token) {
        const authHeader = socket.handshake.headers?.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7);
        }
    }

    // 3. Fallback: query param (for testing only, not recommended for production)
    if (!token) {
        token = socket.handshake.query?.token;
    }

    if (!token) {
        logger.warn(`[SocketAuth] Connection rejected (no token): ${socket.id}`);
        return next(new Error('Authentication required: no token provided'));
    }

    try {
        const decoded = jwt.verify(token, ACCESS_SECRET);
        socket.user = decoded; // attach { id, isAdmin, userType } to socket
        logger.debug(`[SocketAuth] Authenticated socket ${socket.id} → user ${decoded.id}`);
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            logger.warn(`[SocketAuth] Rejected socket ${socket.id}: access token expired. Client must refresh and reconnect.`);
            return next(new Error('Access token expired. Please refresh your token and reconnect.'));
        }
        logger.warn(`[SocketAuth] Rejected socket ${socket.id}: ${err.message}`);
        next(new Error(`Authentication failed: ${err.message}`));
    }
}

module.exports = { socketAuthMiddleware };
