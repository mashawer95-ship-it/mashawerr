const mongoose = require('mongoose');
require('dotenv').config();
const { Order } = require('./middlewares/Order');

async function testAccept() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');

        // Find a waiting order
        const order = await Order.findOne({ status: 'waiting' }).sort({ createdAt: -1 });
        if (!order) {
            console.log('No waiting order found.');
            process.exit(0);
        }

        console.log(`Found waiting order: ${order.orderId}`);
        
        // Simulate accept logic
        order.status = 'accepted';
        order.representativeId = 'test-rep-123';
        await order.save();

        console.log(`Order ${order.orderId} status changed to ${order.status}`);
        
        // Fetch it back to see if it persisted
        const updatedOrder = await Order.findOne({ orderId: order.orderId });
        console.log(`Re-fetched Order ${updatedOrder.orderId} status: ${updatedOrder.status}`);

        // Revert it back to waiting so we don't break the environment permanently
        updatedOrder.status = 'waiting';
        updatedOrder.representativeId = null;
        await updatedOrder.save();
        console.log(`Reverted Order ${updatedOrder.orderId} back to waiting.`);
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        mongoose.connection.close();
    }
}

testAccept();
