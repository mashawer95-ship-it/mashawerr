/**
 * verifytoken.js  (Authentication Middleware)
 *
 * Central authentication layer for Mashawerr API.
 *
 * USAGE in routes:
 *   const { authenticate } = require('../middlewares/verifytoken');
 *
 *   router.get('/orders',  authenticate, orderController.getAll);
 *   router.delete('/users/:id', authenticate, authorize('admin'), userController.deleteUser);
 *
 * On success:
 *   - req.user      = decoded JWT payload  { id, isAdmin, userType }
 *   - req.fullUser  = full Mongoose User document (set by checkUserStatus)
 *
 * On failure:
 *   - 401 { code: 'NO_TOKEN' }               → no token provided
 *   - 401 { code: 'TOKEN_EXPIRED' }          → access token expired → client should call /auth/refresh-token
 *   - 401 { code: 'TOKEN_INVALID' }          → malformed or tampered token
 *
 * BACKWARD COMPATIBILITY:
 *   verifyToken, protect, verifyTokenAndAdmin, verifyTokenAndAuthorization
 *   are still exported as aliases so existing routes keep working unchanged.
 */

const jwt          = require('jsonwebtoken');
const checkUserStatus = require('./checkUserStatus');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;

// ─── Token Extractor ─────────────────────────────────────────────────────────
/**
 * Extract raw JWT string from:
 *   Authorization: Bearer <token>
 *   token / Token header
 *   x-access-token header
 */
function extractToken(req) {
    const authHeader =
        req.headers['authorization'] ||
        req.headers['Authorization'] ||
        req.headers['token']         ||
        req.headers['Token']         ||
        req.headers['x-access-token'];

    if (!authHeader) return null;

    const raw = typeof authHeader === 'string'
        ? authHeader.trim().replace(/^["']|["']$/g, '')
        : authHeader;

    if (raw.toLowerCase().startsWith('bearer ')) {
        return raw.substring(7).trim();
    }
    return raw;
}

// ─── authenticate (primary middleware) ───────────────────────────────────────
/**
 * Verifies the Access Token and enriches req.user.
 * Does NOT handle Refresh Tokens – those go to POST /auth/refresh-token.
 */
async function authenticate(req, res, next) {
    const token = extractToken(req);

    if (!token) {
        return res.status(401).json({
            code:    'NO_TOKEN',
            message: 'Authentication required. Please provide a valid access token.',
        });
    }

    try {
        const decoded = jwt.verify(token, ACCESS_SECRET);

        // Normalise userType casing
        if (decoded && typeof decoded.userType === 'string') {
            decoded.userType = decoded.userType.trim();
        }

        req.user = decoded;

        // Delegate user status checks (suspended, banned device, role drift, etc.)
        return checkUserStatus(req, res, next);

    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({
                code:    'TOKEN_EXPIRED',
                message: 'Access token expired. Use POST /api/auth/refresh-token to get a new one.',
            });
        }

        console.error('[authenticate] JWT error:', err.message);
        return res.status(401).json({
            code:    'TOKEN_INVALID',
            message: 'Invalid access token.',
            error:   err.message,
        });
    }
}

// ─── Backward-Compatible Aliases ─────────────────────────────────────────────

/** @deprecated Use authenticate instead */
const verifyToken = authenticate;

/** @deprecated Use authenticate instead */
const protect = authenticate;

/**
 * @deprecated Use authenticate + authorize('admin') instead.
 * Kept for backward compatibility with existing routes.
 */
function verifyTokenAndAdmin(req, res, next) {
    authenticate(req, res, () => {
        const isAdmin = req.user?.isAdmin || req.fullUser?.isAdmin;
        if (isAdmin) return next();
        return res.status(403).json({
            code:    'FORBIDDEN',
            message: 'Access denied. Admin role required.',
        });
    });
}

/**
 * @deprecated Use authenticate instead (+ manual id check in controller if needed).
 * Kept for backward compatibility.
 */
function verifyTokenAndAuthorization(req, res, next) {
    authenticate(req, res, () => {
        const isAdmin = req.user?.isAdmin || req.fullUser?.isAdmin;
        if (req.user?.id === req.params.id || isAdmin) return next();
        return res.status(403).json({
            code:    'FORBIDDEN',
            message: 'Access denied. You can only access your own resource.',
        });
    });
}

module.exports = {
    authenticate,
    verifyToken,              // alias
    protect,                  // alias
    verifyTokenAndAdmin,      // alias
    verifyTokenAndAuthorization, // alias
    extractToken,             // exported for use in socketAuth
};