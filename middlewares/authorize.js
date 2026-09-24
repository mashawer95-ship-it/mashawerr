/**
 * authorize.js  (Authorization Middleware)
 *
 * Role-based access control for Mashawerr API.
 *
 * USAGE:
 *   const { authenticate }      = require('../middlewares/verifytoken');
 *   const { authorize }         = require('../middlewares/authorize');
 *
 *   // Single role
 *   router.delete('/users/:id', authenticate, authorize('admin'), userController.deleteUser);
 *
 *   // Multiple allowed roles
 *   router.get('/orders',       authenticate, authorize('admin', 'agent'), orderController.getAll);
 *
 *   // Any authenticated user (no role restriction)
 *   router.get('/profile/:id',  authenticate, userController.getProfile);
 *
 * Role Hierarchy (most privileged first):
 *   admin  >  agent  >  administration  >  representative/driver  >  normaluser
 *
 * Rules:
 *   - isAdmin === true  → always allowed (super-admin, bypasses role check)
 *   - Otherwise compare req.user.userType (normalised) against the allowed list
 *
 * BACKWARD COMPATIBILITY:
 *   authorizeRoles, restrictTo and all shorthand arrays are still exported.
 */

const { authenticate } = require('./verifytoken');

// ─── Role normalisation ───────────────────────────────────────────────────────
const ROLE_ALIASES = {
    client:     'normaluser',
    normaluser: 'normaluser',
    driver:     'representative',
    representative: 'representative',
    agent:      'agent',
    administration: 'administration',
    admin:      'admin',
};

function normaliseRole(role) {
    if (!role) return 'normaluser';
    const clean = String(role).trim().toLowerCase();
    return ROLE_ALIASES[clean] || clean;
}

// ─── authorize (primary factory) ─────────────────────────────────────────────
/**
 * Middleware factory: allow only the specified roles.
 *
 * @param {...string} roles  - role names (case-insensitive)
 *   Accepted values: 'admin', 'agent', 'administration', 'representative', 'driver', 'normaluser', 'NormalUser', etc.
 */
function authorize(...roles) {
    const allowedRoles = roles.map(normaliseRole);

    // Expand representative to also include driver (they are the same role)
    if (allowedRoles.includes('representative')) {
        if (!allowedRoles.includes('driver')) allowedRoles.push('driver');
    }

    return (req, res, next) => {
        if (!req.user) {
            // authenticate must run before authorize
            return res.status(401).json({
                code:    'NOT_AUTHENTICATED',
                message: 'Authentication required.',
            });
        }

        // Super-admin bypass
        if (req.user.isAdmin || req.fullUser?.isAdmin) {
            return next();
        }

        const userRole = normaliseRole(req.user.userType || req.fullUser?.userType);

        if (allowedRoles.includes(userRole)) {
            return next();
        }

        return res.status(403).json({
            code:    'FORBIDDEN',
            message: `Access denied. Required role(s): ${roles.join(', ')}.`,
        });
    };
}

// ─── Backward-compatible aliases ─────────────────────────────────────────────

/** @deprecated Use authorize() instead */
const authorizeRoles = (...roles) => authorize(...roles);

/** @deprecated Use authorize() instead */
const restrictTo = (...roles) => authorize(...roles);

// ─── Convenience shorthand middleware arrays ──────────────────────────────────
// These bundle [authenticate, authorize(role)] for backward compatibility.
const adminOnly            = [authenticate, authorize('admin')];
const agentOnly            = [authenticate, authorize('agent')];
const adminOrAgent         = [authenticate, authorize('admin', 'agent')];
const administrationOnly   = [authenticate, authorize('administration')];
const administrationOrAdmin= [authenticate, authorize('administration', 'admin')];
const clientOnly           = [authenticate, authorize('normaluser')];
const anyAuthenticated     = [authenticate];

module.exports = {
    // ✅ Primary exports (use these in new code)
    authorize,

    // 🔁 Backward compatibility
    authorizeRoles,
    restrictTo,

    // 🔁 Shorthand bundles (deprecated but still work)
    adminOnly,
    agentOnly,
    adminOrAgent,
    administrationOnly,
    administrationOrAdmin,
    clientOnly,
    anyAuthenticated,
};
