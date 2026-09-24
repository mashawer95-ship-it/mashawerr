/**
 * Enterprise Object-Level Authorization (BOLA / IDOR Protection)
 * Enforces ownership checks, nested relation checks, and anti-resource-enumeration policies.
 */

/**
 * Handle unauthorized access attempts with strict anti-enumeration error handling.
 * 
 * Rules:
 * - If resource does NOT exist -> HTTP 404 Not Found
 * - If resource exists BUT endpoint/resource is sensitive -> HTTP 404 Not Found (Prevents probing resource IDs)
 * - If resource exists AND not sensitive -> HTTP 403 Forbidden
 * 
 * @param {Object} res - Express response object
 * @param {boolean} resourceExists - Whether the target database object exists
 * @param {boolean} isSensitive - Whether to hide existence behind 404 (Anti-Enumeration)
 * @param {string} customMsg - Optional custom error message
 */
function sanitizeErrorResponse(res, resourceExists, isSensitive = false, customMsg = null) {
    if (!resourceExists || isSensitive) {
        return res.status(404).json({
            message: customMsg || 'Resource not found'
        });
    }
    return res.status(403).json({
        message: customMsg || 'Access denied. You do not have permission to access or modify this resource.'
    });
}

/**
 * Verify if the authenticated user (`req.user`) is authorized to access a given database model instance.
 * 
 * @param {Object} resource - Mongoose document or plain DB object
 * @param {Object} req - Express request containing `req.user`
 * @param {Object} options - Options object
 * @param {string|Array<string>} options.ownerFields - Field(s) on resource matching user ID (e.g. ['userId', 'user', 'client', 'driverId', 'representativeId', 'agentId'])
 * @param {Array<string>} options.allowedRoles - System roles allowed access regardless of explicit ownership (e.g. ['Admin', 'Agent'])
 * @returns {boolean} True if authorized, False otherwise
 */
function isOwnerOrAuthorized(resource, req, options = {}) {
    if (!resource || !req || !req.user) {
        return false;
    }

    const userId = req.user.id || req.user._id;
    if (!userId) return false;

    // Super Admin bypass
    const isAdmin = req.user.isAdmin === true || (req.fullUser && req.fullUser.isAdmin === true);
    if (isAdmin) return true;

    // Role check if allowed roles specified
    if (options.allowedRoles && Array.isArray(options.allowedRoles)) {
        const userRole = (req.user.userType || req.user.role || '').trim().toLowerCase();
        const allowed = options.allowedRoles.map(r => r.toLowerCase());
        if (allowed.includes(userRole)) {
            return true;
        }
    }

    // Direct ownership checks
    const ownerFields = options.ownerFields
        ? (Array.isArray(options.ownerFields) ? options.ownerFields : [options.ownerFields])
        : ['userId', 'user', 'client', 'driverId', 'representativeId', 'agentId', 'fromUserId', 'toUserId'];

    for (const field of ownerFields) {
        const val = resource[field];
        if (val) {
            // Handle populated user object vs raw ObjectId/string ID
            const fieldId = typeof val === 'object' && val._id ? val._id.toString() : val.toString();
            if (fieldId === userId.toString()) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Validates nested parent-child resource relationships to prevent cross-account child manipulation.
 * E.g., verifying `task.orderId` equals `parentOrder._id`.
 * 
 * @param {Object} parentResource - Parent resource document
 * @param {Object} childResource - Child resource document
 * @param {string} foreignKeyField - Field name on child pointing to parent (default 'orderId')
 * @returns {boolean} True if child correctly belongs to parent
 */
function validateNestedRelation(parentResource, childResource, foreignKeyField = 'orderId') {
    if (!parentResource || !childResource) return false;
    
    const parentId = (parentResource._id || parentResource.id)?.toString();
    const foreignVal = childResource[foreignKeyField];
    const childParentId = (typeof foreignVal === 'object' && foreignVal?._id)
        ? foreignVal._id.toString()
        : foreignVal?.toString();

    return parentId === childParentId;
}

module.exports = {
    sanitizeErrorResponse,
    isOwnerOrAuthorized,
    validateNestedRelation
};
