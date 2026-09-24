require('dotenv').config();
const mongoose = require('mongoose');
const { GlobalDiscount } = require('./middlewares/Discount');

async function test() {
    await mongoose.connect(process.env.MONGO_URI);
    const doc = await GlobalDiscount.findOne();
    console.log("DB GlobalDiscount:", doc);
    process.exit(0);
}
test();
