require('dotenv').config();
const m=require('mongoose');
const uri = process.env.MONGO_URI;
if (!uri) { console.error('MONGO_URI is not set'); process.exit(1); }
m.connect(uri).then(async()=>{
  const db=m.connection.db;
  const res=await db.collection('products').updateMany({deliveryPricePerMeter:100}, {$unset:{deliveryPricePerMeter:''}});
  console.log('Updated: ' + res.modifiedCount);
  
  // Also clear cart items to prevent them from having stale product data if any are cached
  await db.collection('carts').updateMany({}, {$set: {items: []}});
  console.log('Carts cleared to force refresh');
  
  process.exit(0);
});
