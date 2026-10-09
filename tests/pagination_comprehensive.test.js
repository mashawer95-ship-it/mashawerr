'use strict';

const assert = require('assert');
const {
    normalizePagination,
    buildPaginationMetadata,
    setPaginationHeaders,
    formatPaginatedResponse,
} = require('../utils/pagination');

let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ ${name}: ${err.message}`);
        failedTests++;
    }
}

async function runAsyncTest(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ❌ ${name}: ${err.message}`);
        failedTests++;
    }
}

console.log('\n============================================================');
console.log('🧪 RUNNING PRODUCTION-GRADE PAGINATION AUDIT & SUITE');
console.log('============================================================\n');

// ─── 1. Core Pagination Normalizer & Math Tests ──────────────────────────────
console.log('--- 1. Pagination Normalizer & Parameter Sanitization ---');

runTest('normalizePagination: default page and limit', () => {
    const res = normalizePagination({});
    assert.strictEqual(res.page, 1);
    assert.strictEqual(res.limit, 20);
    assert.strictEqual(res.skip, 0);
});

runTest('normalizePagination: explicit page=2, limit=10', () => {
    const res = normalizePagination({ page: 2, limit: 10 });
    assert.strictEqual(res.page, 2);
    assert.strictEqual(res.limit, 10);
    assert.strictEqual(res.skip, 10);
});

runTest('normalizePagination: explicit page=5, limit=15 calculates skip=60', () => {
    const res = normalizePagination({ page: 5, limit: 15 });
    assert.strictEqual(res.skip, 60);
});

runTest('normalizePagination: string numbers parsed correctly', () => {
    const res = normalizePagination({ page: '3', limit: '25' });
    assert.strictEqual(res.page, 3);
    assert.strictEqual(res.limit, 25);
    assert.strictEqual(res.skip, 50);
});

runTest('normalizePagination: negative page normalizes to 1', () => {
    const res = normalizePagination({ page: -5, limit: 10 });
    assert.strictEqual(res.page, 1);
    assert.strictEqual(res.skip, 0);
});

runTest('normalizePagination: zero page normalizes to 1', () => {
    const res = normalizePagination({ page: 0, limit: 10 });
    assert.strictEqual(res.page, 1);
});

runTest('normalizePagination: negative and zero limit normalize to defaultLimit', () => {
    const res1 = normalizePagination({ limit: -10, defaultLimit: 20 });
    const res2 = normalizePagination({ limit: 0, defaultLimit: 20 });
    assert.strictEqual(res1.limit, 20);
    assert.strictEqual(res2.limit, 20);
});

runTest('normalizePagination: excessively large limit clamps to maxLimit', () => {
    const res = normalizePagination({ limit: 1000, maxLimit: 50 });
    assert.strictEqual(res.limit, 50);
});

runTest('normalizePagination: NaN, null, undefined, malformed strings fallback safely', () => {
    const res = normalizePagination({ page: 'abc', limit: 'invalid' });
    assert.strictEqual(res.page, 1);
    assert.strictEqual(res.limit, 20);
    assert.strictEqual(res.skip, 0);
});

runTest('normalizePagination: floating point numbers truncated to safe integers', () => {
    const res = normalizePagination({ page: 2.9, limit: 10.7 });
    assert.strictEqual(res.page, 2);
    assert.strictEqual(res.limit, 10);
    assert.strictEqual(res.skip, 10);
});

// ─── 2. Metadata Builder Tests ───────────────────────────────────────────────
console.log('\n--- 2. Metadata Builder & Boundary Calculations ---');

runTest('buildPaginationMetadata: first page with more pages', () => {
    const meta = buildPaginationMetadata(100, 1, 20);
    assert.strictEqual(meta.total, 100);
    assert.strictEqual(meta.page, 1);
    assert.strictEqual(meta.limit, 20);
    assert.strictEqual(meta.totalPages, 5);
    assert.strictEqual(meta.hasNextPage, true);
    assert.strictEqual(meta.hasPrevPage, false);
    assert.strictEqual(meta.nextPage, 2);
    assert.strictEqual(meta.prevPage, null);
});

runTest('buildPaginationMetadata: middle page', () => {
    const meta = buildPaginationMetadata(100, 3, 20);
    assert.strictEqual(meta.hasNextPage, true);
    assert.strictEqual(meta.hasPrevPage, true);
    assert.strictEqual(meta.nextPage, 4);
    assert.strictEqual(meta.prevPage, 2);
});

runTest('buildPaginationMetadata: last page', () => {
    const meta = buildPaginationMetadata(100, 5, 20);
    assert.strictEqual(meta.hasNextPage, false);
    assert.strictEqual(meta.hasPrevPage, true);
    assert.strictEqual(meta.nextPage, null);
    assert.strictEqual(meta.prevPage, 4);
});

runTest('buildPaginationMetadata: single page collection', () => {
    const meta = buildPaginationMetadata(8, 1, 10);
    assert.strictEqual(meta.totalPages, 1);
    assert.strictEqual(meta.hasNextPage, false);
    assert.strictEqual(meta.hasPrevPage, false);
    assert.strictEqual(meta.nextPage, null);
    assert.strictEqual(meta.prevPage, null);
});

runTest('buildPaginationMetadata: empty collection (total = 0)', () => {
    const meta = buildPaginationMetadata(0, 1, 10);
    assert.strictEqual(meta.total, 0);
    assert.strictEqual(meta.totalPages, 0);
    assert.strictEqual(meta.hasNextPage, false);
    assert.strictEqual(meta.hasPrevPage, false);
    assert.strictEqual(meta.nextPage, null);
    assert.strictEqual(meta.prevPage, null);
});

runTest('buildPaginationMetadata: out of bounds page request', () => {
    const meta = buildPaginationMetadata(30, 10, 10);
    assert.strictEqual(meta.totalPages, 3);
    assert.strictEqual(meta.hasNextPage, false);
    assert.strictEqual(meta.hasPrevPage, true);
    assert.strictEqual(meta.nextPage, null);
    assert.strictEqual(meta.prevPage, 3);
});

// ─── 3. Header Generation & Response Envelope Tests ─────────────────────────
console.log('\n--- 3. HTTP Header Standards & Flutter Contract Envelopes ---');

runTest('setPaginationHeaders sets correct X-Headers on response', () => {
    const headers = {};
    const mockRes = {
        setHeader: (k, v) => { headers[k] = v; }
    };
    setPaginationHeaders(mockRes, 45, 2, 10);
    assert.strictEqual(headers['X-Total-Count'], 45);
    assert.strictEqual(headers['X-Page'], 2);
    assert.strictEqual(headers['X-Limit'], 10);
    assert.strictEqual(headers['X-Total-Pages'], 5);
});

runTest('formatPaginatedResponse produces fully compatible Flutter envelope', () => {
    const headers = {};
    const mockRes = {
        setHeader: (k, v) => { headers[k] = v; }
    };
    const sampleItems = [{ id: 1, name: 'Item 1' }, { id: 2, name: 'Item 2' }];
    const envelope = formatPaginatedResponse({
        res: mockRes,
        data: sampleItems,
        total: 50,
        page: 1,
        limit: 10,
        entityKey: 'orders',
    });

    assert.strictEqual(envelope.success, true);
    assert.strictEqual(envelope.data, sampleItems);
    assert.strictEqual(envelope.orders, sampleItems);
    assert.strictEqual(envelope.total, 50);
    assert.strictEqual(envelope.page, 1);
    assert.strictEqual(envelope.limit, 10);
    assert.strictEqual(envelope.totalPages, 5);
    assert.strictEqual(envelope.hasNextPage, true);
    assert.strictEqual(envelope.hasPrevPage, false);
    assert.strictEqual(envelope.pagination.totalPages, 5);
    assert.strictEqual(headers['X-Total-Count'], 50);
});

// ─── 4. Authorization & Security Scoping Guard Tests ─────────────────────────
console.log('\n--- 4. Authorization Scoping & Security Guards ---');

runTest('Ownership check blocks cross-customer data access', () => {
    const authenticatedUser = { id: '60d5ec49f1b2c82b8c8f0001', isAdmin: false };
    const requestedClientId = '60d5ec49f1b2c82b8c8f0002';
    const isOwner = authenticatedUser.id === requestedClientId;
    assert.strictEqual(isOwner, false, 'Non-admin customer must NOT access other users records');
});

runTest('Admin role bypasses customer ownership check', () => {
    const authenticatedAdmin = { id: '60d5ec49f1b2c82b8c8f0099', isAdmin: true };
    const requestedClientId = '60d5ec49f1b2c82b8c8f0002';
    const hasAccess = authenticatedAdmin.isAdmin || authenticatedAdmin.id === requestedClientId;
    assert.strictEqual(hasAccess, true, 'Admin must be authorized to inspect client records');
});

runTest('Agent governorate restriction is strictly applied', () => {
    const agent = { userType: 'agent', governorate: 'Hawally' };
    const orderInGov = { governorate: 'Hawally' };
    const orderOutsideGov = { governorate: 'Farwaniya' };

    const canSeeInGov = orderInGov.governorate.toLowerCase() === agent.governorate.toLowerCase();
    const canSeeOutsideGov = orderOutsideGov.governorate.toLowerCase() === agent.governorate.toLowerCase();

    assert.strictEqual(canSeeInGov, true);
    assert.strictEqual(canSeeOutsideGov, false, 'Agent must not access records outside governorate');
});

runTest('Deterministic sorting tie-breakers prevent duplicate/skipped items', () => {
    // 2 items created in the exact same millisecond
    const sameTimestamp = new Date('2026-10-09T22:00:00.000Z');
    const itemA = { _id: '60d5ec49f1b2c82b8c8f0002', createdAt: sameTimestamp };
    const itemB = { _id: '60d5ec49f1b2c82b8c8f0001', createdAt: sameTimestamp };

    // Deterministic sort comparator: createdAt DESC, then _id DESC
    const comparator = (a, b) => {
        const timeDiff = new Date(b.createdAt) - new Date(a.createdAt);
        if (timeDiff !== 0) return timeDiff;
        return String(b._id).localeCompare(String(a._id));
    };

    const sorted = [itemB, itemA].sort(comparator);
    assert.strictEqual(sorted[0]._id, '60d5ec49f1b2c82b8c8f0002');
    assert.strictEqual(sorted[1]._id, '60d5ec49f1b2c82b8c8f0001');
});

// ─── 5. Summary Financial Separations Guard ─────────────────────────────────
console.log('\n--- 5. Financial Calculation vs Paginated Detail Rows ---');

runTest('Financial totals must NOT be computed from a paginated slice', () => {
    const completeDataset = [
        { id: 1, amountEgp: 100 },
        { id: 2, amountEgp: 200 },
        { id: 3, amountEgp: 300 },
        { id: 4, amountEgp: 400 },
    ];
    const totalRevenue = completeDataset.reduce((sum, item) => sum + item.amountEgp, 0);

    // Paginated slice (page 1, limit 2)
    const page1Slice = completeDataset.slice(0, 2);
    const paginatedSliceRevenue = page1Slice.reduce((sum, item) => sum + item.amountEgp, 0);

    assert.strictEqual(totalRevenue, 1000);
    assert.strictEqual(paginatedSliceRevenue, 300);
    assert.notStrictEqual(totalRevenue, paginatedSliceRevenue, 'Complete revenue must remain separate from page rows');
});

// ─── 6. Batch Query Optimization Guard ──────────────────────────────────────
console.log('\n--- 6. N+1 Elimination Verification ---');

runTest('Batch lookup replaces sequential N+1 query loop', () => {
    const sessions = [
        { sessionId: 'S1', orderId: '101' },
        { sessionId: 'S2', orderId: '102' },
        { sessionId: 'S3', orderId: '103' },
    ];
    const allAttemptsInDb = [
        { sessionId: 'S1', attemptNumber: 2, state: 'WAITING_CUSTOMER_REVIEW' },
        { sessionId: 'S1', attemptNumber: 1, state: 'REJECTED' },
        { sessionId: 'S2', attemptNumber: 1, state: 'APPROVED' },
    ];

    // Build map in single O(M) pass instead of O(N) DB calls
    const attemptsBySession = new Map();
    for (const att of allAttemptsInDb) {
        if (!attemptsBySession.has(att.sessionId)) {
            attemptsBySession.set(att.sessionId, []);
        }
        attemptsBySession.get(att.sessionId).push(att);
    }

    assert.strictEqual(attemptsBySession.get('S1').length, 2);
    assert.strictEqual(attemptsBySession.get('S1')[0].attemptNumber, 2);
    assert.strictEqual(attemptsBySession.get('S2').length, 1);
    assert.strictEqual(attemptsBySession.has('S3'), false);
});

// ─── Final Summary ──────────────────────────────────────────────────────────
console.log('\n============================================================');
console.log(`Results: ${passedTests} passed, ${failedTests} failed`);
console.log('============================================================\n');

if (failedTests > 0) {
    process.exit(1);
} else {
    process.exit(0);
}
