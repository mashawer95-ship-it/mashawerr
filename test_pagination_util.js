'use strict';

const assert = require('assert');
const {
    normalizePagination,
    buildPaginationMetadata,
    formatPaginatedResponse,
    DEFAULT_PAGE,
    DEFAULT_LIMIT,
    MAX_LIMIT,
} = require('./utils/pagination');

console.log('🧪 Testing utils/pagination.js ...\n');

// Test 1: Defaults
{
    const { page, limit, skip } = normalizePagination({});
    assert.strictEqual(page, DEFAULT_PAGE, 'default page should be 1');
    assert.strictEqual(limit, DEFAULT_LIMIT, 'default limit should be 20');
    assert.strictEqual(skip, 0, 'default skip should be 0');
    console.log('✅ Test 1 Passed: Default pagination values');
}

// Test 2: Valid explicit page and limit
{
    const { page, limit, skip } = normalizePagination({ page: '3', limit: '15' });
    assert.strictEqual(page, 3);
    assert.strictEqual(limit, 15);
    assert.strictEqual(skip, 30);
    console.log('✅ Test 2 Passed: Explicit page and limit parsed accurately');
}

// Test 3: Clamping excessive limit to MAX_LIMIT (50)
{
    const { page, limit, skip } = normalizePagination({ page: '1', limit: '999999' });
    assert.strictEqual(limit, MAX_LIMIT, 'limit should be clamped to MAX_LIMIT');
    console.log('✅ Test 3 Passed: Excessive limit clamped to maxLimit');
}

// Test 4: Handling invalid/negative/zero/non-numeric values
{
    const testCases = [
        { query: { page: '-5', limit: '0' }, expectedPage: 1, expectedLimit: 20 },
        { query: { page: '0', limit: '-10' }, expectedPage: 1, expectedLimit: 20 },
        { query: { page: 'abc', limit: 'xyz' }, expectedPage: 1, expectedLimit: 20 },
        { query: { page: null, limit: undefined }, expectedPage: 1, expectedLimit: 20 },
    ];

    for (const tc of testCases) {
        const res = normalizePagination(tc.query);
        assert.strictEqual(res.page, tc.expectedPage);
        assert.strictEqual(res.limit, tc.expectedLimit);
    }
    console.log('✅ Test 4 Passed: Malformed, zero, negative & string values safely normalized');
}

// Test 5: Metadata generation & boundary calculations
{
    const meta = buildPaginationMetadata({ total: 45, page: 2, limit: 20 });
    assert.strictEqual(meta.total, 45);
    assert.strictEqual(meta.page, 2);
    assert.strictEqual(meta.limit, 20);
    assert.strictEqual(meta.totalPages, 3);
    assert.strictEqual(meta.hasNextPage, true);
    assert.strictEqual(meta.hasPrevPage, true);
    assert.strictEqual(meta.nextPage, 3);
    assert.strictEqual(meta.prevPage, 1);
    console.log('✅ Test 5 Passed: Metadata calculations (middle page)');
}

// Test 6: Metadata on empty collection
{
    const meta = buildPaginationMetadata({ total: 0, page: 1, limit: 20 });
    assert.strictEqual(meta.total, 0);
    assert.strictEqual(meta.totalPages, 0);
    assert.strictEqual(meta.hasNextPage, false);
    assert.strictEqual(meta.hasPrevPage, false);
    assert.strictEqual(meta.nextPage, null);
    assert.strictEqual(meta.prevPage, null);
    console.log('✅ Test 6 Passed: Empty collection metadata');
}

// Test 7: formatPaginatedResponse payload structure
{
    const mockRes = {
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
    };

    const items = [{ id: 1 }, { id: 2 }];
    const resPayload = formatPaginatedResponse({
        res: mockRes,
        data: items,
        total: 50,
        page: 1,
        limit: 10,
        entityKey: 'orders',
    });

    assert.strictEqual(resPayload.success, true);
    assert.deepStrictEqual(resPayload.orders, items);
    assert.deepStrictEqual(resPayload.data, items);
    assert.strictEqual(resPayload.total, 50);
    assert.strictEqual(resPayload.page, 1);
    assert.strictEqual(resPayload.limit, 10);
    assert.strictEqual(resPayload.totalPages, 5);
    assert.strictEqual(resPayload.pagination.hasNextPage, true);
    assert.strictEqual(mockRes.headers['X-Total-Count'], 50);
    assert.strictEqual(mockRes.headers['X-Page'], 1);
    assert.strictEqual(mockRes.headers['X-Total-Pages'], 5);
    console.log('✅ Test 7 Passed: formatPaginatedResponse builds backward-compatible payload and headers');
}

console.log('\n🎉 ALL 7 PAGINATION UNIT TESTS PASSED SUCCESSFULLY!\n');
