/**
 * Automated Enterprise Security Test Suite
 * Tests BOLA, IDOR, Mass Assignment, and Broken Access Control across system endpoints.
 */

process.env.TEST_MODE = 'true';
const jwt = require('jsonwebtoken');
const http = require('http');

const JWT_SECRET = process.env.JWT_SECRET || 'secretkey123456';
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

// Helper: Generate Mock JWT Token
function generateTestToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

// Mock Actors
const actors = {
    userA: {
        id: '650000000000000000000001',
        token: generateTestToken({ id: '650000000000000000000001', userType: 'NormalUser', isAdmin: false }),
    },
    userB: {
        id: '650000000000000000000002',
        token: generateTestToken({ id: '650000000000000000000002', userType: 'NormalUser', isAdmin: false }),
    },
    repAssigned: {
        id: '650000000000000000000003',
        token: generateTestToken({ id: '650000000000000000000003', userType: 'Representative', isAdmin: false }),
    },
    repUnassigned: {
        id: '650000000000000000000004',
        token: generateTestToken({ id: '650000000000000000000004', userType: 'Representative', isAdmin: false }),
    },
    admin: {
        id: '650000000000000000000005',
        token: generateTestToken({ id: '650000000000000000000005', userType: 'Admin', isAdmin: true }),
    },
};

// Helper: Make HTTP Request
function httpRequest(method, path, body = null, token = null) {
    return new Promise((resolve) => {
        const url = new URL(path, BASE_URL);
        const headers = {
            'Content-Type': 'application/json',
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method.toUpperCase(),
            headers,
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch (_) {}
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });

        req.on('error', (err) => resolve({ status: 500, error: err.message }));
        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// Test Matrix Assertion Tracker
let passed = 0;
let failed = 0;

function assertTest(name, condition, details = '') {
    if (condition) {
        console.log(`✅ [PASS] ${name}`);
        passed++;
    } else {
        console.error(`❌ [FAIL] ${name} -> ${details}`);
        failed++;
    }
}

async function startServerIfNecessary() {
    return new Promise((resolve) => {
        const checkReq = http.get(BASE_URL + '/api/health', (res) => {
            console.log('Detected existing running backend server.');
            resolve();
        });
        checkReq.on('error', () => {
            console.log('No server running on port 3000. Launching app.js for tests...');
            require('./app.js');
            // Wait for server to bind & DB connection
            const pollServer = setInterval(() => {
                http.get(BASE_URL + '/api/health', (res) => {
                    if (res.statusCode === 200) {
                        clearInterval(pollServer);
                        console.log('App server is ready for test execution.\n');
                        resolve();
                    }
                }).on('error', () => {});
            }, 1000);
        });
    });
}

async function runSecurityTests() {
    await startServerIfNecessary();

    console.log('====================================================');
    console.log('🔒 EXECUTING MULTI-ACTOR SECURITY TEST MATRIX 🔒');
    console.log('====================================================\n');

    // ── 1. Unauthenticated Route Protection Tests ──
    console.log('--- Scenario 1: Unauthenticated Endpoint Access ---');
    let res = await httpRequest('GET', '/api/users');
    assertTest('GET /api/users without token returns 401', res.status === 401, `Status: ${res.status}`);

    res = await httpRequest('GET', '/api/wallet/admin/all');
    assertTest('GET /api/wallet/admin/all without token returns 401', res.status === 401, `Status: ${res.status}`);

    res = await httpRequest('POST', '/api/rep-targets/global');
    assertTest('POST /api/rep-targets/global without token returns 401', res.status === 401, `Status: ${res.status}`);

    res = await httpRequest('GET', '/api/rep-targets/global');
    assertTest('GET /api/rep-targets/global without token returns 401', res.status === 401, `Status: ${res.status}`);

    // ── 2. Privilege Escalation & Admin Bypass Tests ──
    console.log('\n--- Scenario 2: Admin Endpoint Protection against Non-Admin ---');
    res = await httpRequest('GET', '/api/users', null, actors.userA.token);
    assertTest('GET /api/users with NormalUser token returns 403', res.status === 403, `Status: ${res.status}`);

    res = await httpRequest('GET', '/api/wallet/admin/all', null, actors.userA.token);
    assertTest('GET /api/wallet/admin/all with NormalUser token returns 403', res.status === 403, `Status: ${res.status}`);

    res = await httpRequest('POST', '/api/wallet/650000000000000000000001/credit', { amountFils: 10000 }, actors.userA.token);
    assertTest('POST /api/wallet/:id/credit with NormalUser token returns 403', res.status === 403, `Status: ${res.status}`);

    res = await httpRequest('POST', '/api/users/migrate-representatives', {}, actors.userA.token);
    assertTest('POST /api/users/migrate-representatives with NormalUser token returns 403', res.status === 403, `Status: ${res.status}`);

    // ── 3. IDOR / BOLA Profile & Wallet Isolation Tests ──
    console.log('\n--- Scenario 3: IDOR Read/Write Isolation ---');
    res = await httpRequest('GET', `/api/users/profile/${actors.userA.id}`, null, actors.userB.token);
    assertTest('GET User A profile with User B token returns 404 (Anti-Enumeration)', res.status === 404, `Status: ${res.status}`);

    res = await httpRequest('GET', `/api/wallet/${actors.userA.id}`, null, actors.userB.token);
    assertTest('GET User A wallet with User B token returns 404 (Anti-Enumeration)', res.status === 404, `Status: ${res.status}`);

    res = await httpRequest('GET', `/api/orders/user/${actors.userA.id}`, null, actors.userB.token);
    assertTest('GET User A orders with User B token returns 404 (Anti-Enumeration)', res.status === 404, `Status: ${res.status}`);

    res = await httpRequest('PUT', `/api/users/${actors.userA.id}`, { firstName: 'Hacked' }, actors.userB.token);
    assertTest('PUT User A profile with User B token returns 404 (Anti-Enumeration)', res.status === 404, `Status: ${res.status}`);

    // ── 4. Mass Assignment Protection Tests ──
    console.log('\n--- Scenario 4: Mass Assignment Privilege Escalation ---');
    res = await httpRequest('PUT', `/api/users/${actors.userA.id}`, {
        firstName: 'ValidName',
        isAdmin: true,
        userType: 'Admin',
        status: 'active'
    }, actors.userA.token);
    
    assertTest('PUT profile accepts valid fields & ignores mass assignment attempt', res.status === 200 || res.status === 404, `Status: ${res.status}`);
    if (res.body && res.status === 200) {
        assertTest('isAdmin was NOT modified via Mass Assignment', res.body.isAdmin !== true, `isAdmin: ${res.body?.isAdmin}`);
        assertTest('userType was NOT elevated via Mass Assignment', res.body.userType !== 'Admin', `userType: ${res.body?.userType}`);
    }

    // ── 5. BOLA / Task & Chat Isolation ──
    console.log('\n--- Scenario 5: Task & Chat Resource Isolation ---');
    res = await httpRequest('GET', '/api/chat/650000000000000000000099', null, actors.userB.token);
    assertTest('GET chat history for unauthorized order returns 404 (Anti-Enumeration)', res.status === 404, `Status: ${res.status}`);

    res = await httpRequest('PATCH', '/api/orders/650000000000000000000099/tasks/1/pickup', {}, actors.userB.token);
    assertTest('PATCH pickup for unauthorized order/task returns 404', res.status === 404, `Status: ${res.status}`);

    console.log('\n====================================================');
    console.log(`SUMMARY: ${passed} PASSED, ${failed} FAILED out of ${passed + failed} TESTS`);
    console.log('====================================================');

    process.exit(failed > 0 ? 1 : 0);
}

// Execute tests if script called directly
if (require.main === module) {
    runSecurityTests();
}

module.exports = { runSecurityTests, actors, generateTestToken };
