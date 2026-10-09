'use strict';

/**
 * utils/pagination.js
 * Production-grade pagination helper for Mashawerr API.
 * Provides safe parameter normalization, bounds enforcement, metadata construction,
 * and HTTP response header population.
 */

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Safely parse and normalize page and limit query parameters.
 * Enforces positive integers and strict maximum bounds.
 *
 * @param {Object} query - Express req.query object
 * @param {Object} [options] - Configuration options
 * @param {number} [options.defaultLimit=20] - Default limit if not provided
 * @param {number} [options.maxLimit=50] - Maximum allowed limit
 * @returns {{ page: number, limit: number, skip: number }}
 */
function normalizePagination(query = {}, options = {}) {
    const defaultLimit = Number.isInteger(options.defaultLimit) && options.defaultLimit > 0
        ? options.defaultLimit
        : DEFAULT_LIMIT;

    const maxLimit = Number.isInteger(options.maxLimit) && options.maxLimit > 0
        ? options.maxLimit
        : MAX_LIMIT;

    // Parse page: must be integer >= 1
    let page = parseInt(query.page, 10);
    if (isNaN(page) || page < 1) {
        page = DEFAULT_PAGE;
    }

    // Parse limit: must be integer between 1 and maxLimit
    let limit = parseInt(query.limit, 10);
    if (isNaN(limit) || limit < 1) {
        limit = defaultLimit;
    } else if (limit > maxLimit) {
        limit = maxLimit;
    }

    const skip = (page - 1) * limit;

    return { page, limit, skip };
}

/**
 * Build standard pagination metadata object.
 *
 * @param {Object} params
 * @param {number} params.total - Total number of matching documents
 * @param {number} params.page - Current page number
 * @param {number} params.limit - Page size
 * @returns {Object} Standard pagination metadata
 */
function buildPaginationMetadata(totalOrObj = 0, pageArg = 1, limitArg = DEFAULT_LIMIT) {
    let total = 0;
    let page = 1;
    let limit = DEFAULT_LIMIT;

    if (totalOrObj && typeof totalOrObj === 'object') {
        total = totalOrObj.total !== undefined ? totalOrObj.total : 0;
        page = totalOrObj.page !== undefined ? totalOrObj.page : 1;
        limit = totalOrObj.limit !== undefined ? totalOrObj.limit : DEFAULT_LIMIT;
    } else {
        total = totalOrObj;
        page = pageArg;
        limit = limitArg;
    }

    const safeTotal = Math.max(0, parseInt(total, 10) || 0);
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT);
    const totalPages = safeTotal > 0 ? Math.ceil(safeTotal / safeLimit) : 0;

    return {
        page: safePage,
        limit: safeLimit,
        total: safeTotal,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1 && totalPages > 0,
        nextPage: safePage < totalPages ? safePage + 1 : null,
        prevPage: safePage > 1 ? Math.min(safePage - 1, totalPages) : null,
    };
}

/**
 * Set standard HTTP headers for pagination on the Express response.
 *
 * @param {Object} res - Express response object
 * @param {Object|number} totalOrMeta - Metadata object or total count
 * @param {number} [pageArg] - Current page number
 * @param {number} [limitArg] - Page size
 */
function setPaginationHeaders(res, totalOrMeta, pageArg, limitArg) {
    if (!res || typeof res.setHeader !== 'function') return;

    let total, page, limit, totalPages;
    if (totalOrMeta && typeof totalOrMeta === 'object') {
        total = totalOrMeta.total;
        page = totalOrMeta.page;
        limit = totalOrMeta.limit;
        totalPages = totalOrMeta.totalPages;
    } else {
        total = totalOrMeta;
        page = pageArg;
        limit = limitArg;
        if (total !== undefined && limit !== undefined && limit > 0) {
            totalPages = Math.ceil(total / limit);
        }
    }

    if (total !== undefined) res.setHeader('X-Total-Count', total);
    if (page !== undefined) res.setHeader('X-Page', page);
    if (totalPages !== undefined) res.setHeader('X-Total-Pages', totalPages);
    if (limit !== undefined) res.setHeader('X-Limit', limit);
}

/**
 * Format a fully backward-compatible paginated JSON response payload.
 * Provides both entityKey (e.g. 'orders', 'users') and 'data' array so Flutter
 * and third-party consumers can safely read the collection under either convention.
 *
 * @param {Object} options
 * @param {Object} [options.res] - Express response object (optional, for setting headers)
 * @param {Array} options.data - The page slice of items
 * @param {number} options.total - Total document count
 * @param {number} options.page - Current page number
 * @param {number} options.limit - Page size
 * @param {string} [options.entityKey='items'] - Primary entity key name ('orders', 'users', etc.)
 * @param {Object} [options.extra={}] - Additional top-level fields (e.g. summary, counts)
 * @returns {Object} Response JSON payload
 */
function formatPaginatedResponse({
    res,
    data = [],
    total = 0,
    page = 1,
    limit = DEFAULT_LIMIT,
    entityKey = 'items',
    extra = {},
}) {
    const meta = buildPaginationMetadata({ total, page, limit });

    if (res) {
        setPaginationHeaders(res, meta);
    }

    const payload = {
        success: true,
        [entityKey]: data,
        data,
        total: meta.total,
        page: meta.page,
        limit: meta.limit,
        totalPages: meta.totalPages,
        hasNextPage: meta.hasNextPage,
        hasPrevPage: meta.hasPrevPage,
        nextPage: meta.nextPage,
        prevPage: meta.prevPage,
        pagination: meta,
        ...extra,
    };

    return payload;
}

module.exports = {
    DEFAULT_PAGE,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    normalizePagination,
    buildPaginationMetadata,
    setPaginationHeaders,
    formatPaginatedResponse,
};
