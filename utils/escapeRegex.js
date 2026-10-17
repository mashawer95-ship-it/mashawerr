/**
 * Escape user input before building a RegExp / $regex query.
 * Prevents ReDoS and regex-injection from query-string parameters.
 */
function escapeRegex(value) {
    return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { escapeRegex };
