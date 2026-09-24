require('dotenv').config();
const { banIdentifier, unbanIdentifier, isBanned, normalizePhone } = require('./services/bannedDeviceService');
const BannedDevice = require('./models/BannedDevice');

async function runUnitTests() {
    console.log('🚀 Running Unit & Service Verification Tests for BannedDevice...\n');

    // 1. Phone Normalization Test
    console.log('📌 Test 1: Phone Normalization Test...');
    const rawPhone = ' +20 100 999 8877 ';
    const cleanPhone = normalizePhone(rawPhone);
    console.log(`Original: "${rawPhone}" -> Normalized: "${cleanPhone}"`);
    if (cleanPhone !== '+201009998877') {
        throw new Error('FAILED: Phone normalization did not format correctly!');
    }
    console.log('✅ Test 1 Passed: Phone normalization works correctly.\n');

    // 2. Redis Fast Ban & Check Test (without requiring live MongoDB Atlas)
    console.log('📌 Test 2: In-Memory / Redis Ban & Check Test...');
    const testData = {
        phone: '+201009998877',
        fcmToken: 'fcm_token_unit_test_abc123xyz',
        deviceId: 'device_hardware_uuid_999888',
        email: 'banned_test_user@mashawerr.app',
        userId: '65f1a2b3c4d5e6f7a8b9c0d1',
        reason: 'ACCOUNT_DELETED_BY_ADMIN',
    };

    // Override Mongoose model methods safely for isolated unit testing if DB is offline
    const originalCreate = BannedDevice.create;
    const originalFindOne = BannedDevice.findOne;
    const originalFindByIdAndUpdate = BannedDevice.findByIdAndUpdate;

    const dummyDbStore = [];

    BannedDevice.create = async function(data) {
        const item = { _id: 'dummy_id_123', ...data, createdAt: new Date(), updatedAt: new Date() };
        dummyDbStore.push(item);
        return item;
    };

    BannedDevice.findOne = function(query) {
        return {
            lean: async () => {
                const match = dummyDbStore.find(item => {
                    if (!item.isActive) return false;
                    if (query.$or) {
                        return query.$or.some(cond => {
                            if (cond.phone && item.phone === cond.phone) return true;
                            if (cond.fcmToken && item.fcmToken === cond.fcmToken) return true;
                            if (cond.deviceId && item.deviceId === cond.deviceId) return true;
                            if (cond.email && item.email === cond.email) return true;
                            return false;
                        });
                    }
                    return false;
                });
                return match || null;
            }
        };
    };

    BannedDevice.find = function(query) {
        const matches = dummyDbStore.filter(item => {
            if (query.phone && item.phone === query.phone) return true;
            if (query.isActive !== undefined && item.isActive !== query.isActive) return false;
            return true;
        });
        return {
            sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => matches }) }) }),
            lean: async () => matches,
            exec: async () => matches,
            then: (resolve) => resolve(matches),
        };
    };

    BannedDevice.updateMany = async function(query, update) {
        dummyDbStore.forEach(item => {
            if (query.phone && item.phone === query.phone) item.isActive = update.isActive;
        });
        return { modifiedCount: dummyDbStore.length };
    };

    try {
        // Test Banning
        console.log('Attempting banIdentifier...');
        await banIdentifier(testData);
        console.log('Ban record created in mock store.');

        // Test Checking by Phone
        const phoneCheck = await isBanned({ phone: testData.phone });
        console.log('Phone check result:', phoneCheck);
        if (!phoneCheck.isBanned) {
            throw new Error('FAILED: Banned phone number was not detected!');
        }
        console.log('✅ Test 2a Passed: Banned phone blocked.\n');

        // Test Checking by FCM Token
        const fcmCheck = await isBanned({ fcmToken: testData.fcmToken });
        console.log('FCM check result:', fcmCheck);
        if (!fcmCheck.isBanned) {
            throw new Error('FAILED: Banned FCM token was not detected!');
        }
        console.log('✅ Test 2b Passed: Banned FCM token blocked.\n');

        // Test Checking by Device ID
        const devCheck = await isBanned({ deviceId: testData.deviceId });
        console.log('Device ID check result:', devCheck);
        if (!devCheck.isBanned) {
            throw new Error('FAILED: Banned Device ID was not detected!');
        }
        console.log('✅ Test 2c Passed: Banned Device ID blocked.\n');

        // Test Clean Identifier
        const cleanCheck = await isBanned({ phone: '+201111111111' });
        console.log('Clean phone check result:', cleanCheck);
        if (cleanCheck.isBanned) {
            throw new Error('FAILED: Clean phone number incorrectly reported as banned!');
        }
        console.log('✅ Test 2d Passed: Clean phone allowed.\n');

        // Test Unban
        console.log('Attempting unbanIdentifier...');
        await unbanIdentifier(testData.phone);
        const postUnbanCheck = await isBanned({ phone: testData.phone });
        console.log('Post unban check result:', postUnbanCheck);
        if (postUnbanCheck.isBanned) {
            throw new Error('FAILED: Phone number still banned after unban!');
        }
        console.log('✅ Test 2e Passed: Unban operation successful.\n');

        console.log('🎉 ALL SERVICE UNIT TESTS PASSED SUCCESSFULLY! 🎉');
    } finally {
        BannedDevice.create = originalCreate;
        BannedDevice.findOne = originalFindOne;
        BannedDevice.findByIdAndUpdate = originalFindByIdAndUpdate;
    }
}

runUnitTests();
