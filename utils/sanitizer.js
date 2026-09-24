/**
 * Input Sanitizer and Whitelisting Utility
 * Protects endpoints against Mass Assignment (Privilege Escalation) vulnerabilities.
 */

/**
 * Filter an incoming request body or object, retaining ONLY explicitly whitelisted keys.
 * 
 * @param {Object} input - The input object (e.g. req.body)
 * @param {Array<string>} allowedKeys - List of field names allowed to be updated
 * @returns {Object} Clean object containing only whitelisted properties
 */
function pickAllowedFields(input, allowedKeys = []) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }

    // Always block critical protected fields from mass assignment
    const FORBIDDEN_FIELDS = new Set([
        'isAdmin',
        'userType',
        'role',
        'walletBalance',
        'wallet',
        'commissionRate',
        'isVerified',
        'isBlocked',
        'isSuspended',
        'rating',
        '_id',
        'id',
        'createdAt',
        'updatedAt',
        'password',
        'passwordHash',
        'salt',
        'resetToken',
        'resetPasswordToken',
        'verificationCode'
    ]);

    const sanitized = {};

    for (const key of allowedKeys) {
        if (Object.prototype.hasOwnProperty.call(input, key) && !FORBIDDEN_FIELDS.has(key)) {
            if (input[key] !== undefined) {
                sanitized[key] = input[key];
            }
        }
    }

    return sanitized;
}

/**
 * Strip blacklisted security fields from an input object.
 * 
 * @param {Object} input - The input object
 * @returns {Object} Object stripped of privilege escalation properties
 */
function stripProtectedFields(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }

    const FORBIDDEN_FIELDS = new Set([
        'isAdmin',
        'userType',
        'role',
        'walletBalance',
        'wallet',
        'commissionRate',
        'isVerified',
        'isBlocked',
        'isSuspended',
        'rating',
        '_id',
        'id',
        'createdAt',
        'updatedAt',
        'password',
        'passwordHash',
        'salt'
    ]);

    const sanitized = { ...input };

    for (const field of FORBIDDEN_FIELDS) {
        delete sanitized[field];
    }

    return sanitized;
}

module.exports = {
    pickAllowedFields,
    stripProtectedFields
};
