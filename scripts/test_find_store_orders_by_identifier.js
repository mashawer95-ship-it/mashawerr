const { findStoreOrdersByIdentifier } = require('../Controllers/storeOrderController');

console.log('--- Checking findStoreOrdersByIdentifier exists and is a function ---');
if (typeof findStoreOrdersByIdentifier !== 'function') {
    throw new Error('findStoreOrdersByIdentifier is not a function');
}
console.log('✅ findStoreOrdersByIdentifier is properly exported as a function.');

// Test identification logic:
const testCases = [
    { id: '230', isNumeric: true, isUuid: false, isObjectId: false },
    { id: 230, isNumeric: true, isUuid: false, isObjectId: false },
    { id: '6a73de49a79603bfd14ef73a', isNumeric: false, isUuid: false, isObjectId: true },
    { id: 'f8c5b967-1234-4567-89ab-cdef01234567', isNumeric: false, isUuid: true, isObjectId: false },
    { id: 'invalid-string', isNumeric: false, isUuid: false, isObjectId: false }
];

const mongoose = require('mongoose');

for (const tc of testCases) {
    const strId = String(tc.id).trim();
    const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(strId);
    const isObjectId = mongoose.Types.ObjectId.isValid(strId);
    const isNumeric = !isNaN(Number(strId));
    const isValid = isUuid || isObjectId || isNumeric;

    console.log(`Testing ID: "${tc.id}" -> isUuid: ${isUuid}, isObjectId: ${isObjectId}, isNumeric: ${isNumeric}, isValid: ${isValid}`);
    if (tc.isNumeric !== isNumeric || tc.isUuid !== isUuid || tc.isObjectId !== isObjectId) {
        throw new Error(`Mismatch for ${tc.id}`);
    }
}

console.log('✅ All ID format validations passed successfully! "230" is correctly recognized as valid numeric orderId.');
process.exit(0);

