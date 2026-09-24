const mongoose = require('mongoose');
require('dotenv').config();
const { StoreOrder } = require('./middlewares/StoreOrder');

async function check() {
    await mongoose.connect(process.env.MONGO_URI);
    const agg = await StoreOrder.aggregate([
        { $group: { _id: '$storeOrderId', statuses: { $addToSet: '$status' } } },
        { $project: { count: { $size: '$statuses' }, statuses: 1 } },
        { $match: { count: { $gt: 1 } } }
    ]);
    console.log('Multi-status storeOrders:', agg);
    process.exit(0);
}
check();
