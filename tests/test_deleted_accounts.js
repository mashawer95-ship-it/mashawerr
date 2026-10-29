const assert = require('assert');
const mongoose = require('mongoose');
const { User } = require('../middlewares/User');
const { Order } = require('../middlewares/Order');

async function runTests() {
    console.log('🧪 Starting Soft-Delete & Deleted Accounts Unit Tests...');

    // 1. Check UserSchema has soft delete fields
    const paths = User.schema.paths;
    assert(paths['isDeleted'], 'User schema must have isDeleted field');
    assert(paths['deletedAt'], 'User schema must have deletedAt field');
    assert(paths['deleteReason'], 'User schema must have deleteReason field');
    assert(paths['deleteNotes'], 'User schema must have deleteNotes field');
    console.log('✅ 1. UserSchema soft-delete fields verified');

    // 2. Check indexes
    const indexes = User.schema.indexes();
    const hasDeletedIndex = indexes.some(idx => idx[0] && idx[0].isDeleted !== undefined);
    assert(hasDeletedIndex, 'User schema must have index on isDeleted');
    console.log('✅ 2. Scalability indexes for millions of users verified');

    // 3. Test Controller Handlers Existence
    const userController = require('../Controllers/userController');
    assert(typeof userController.deleteOwnAccount === 'function', 'deleteOwnAccount must be exported');
    assert(typeof userController.getDeletedAccounts === 'function', 'getDeletedAccounts must be exported');
    assert(typeof userController.restoreDeletedAccount === 'function', 'restoreDeletedAccount must be exported');
    assert(typeof userController.DeleteUserbyid === 'function', 'DeleteUserbyid must be exported');
    console.log('✅ 3. Controller handlers exported correctly');

    console.log('🎉 All Soft-Delete Backend Unit Tests Passed Successfully!\n');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
