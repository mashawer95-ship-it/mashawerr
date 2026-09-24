require('dotenv').config();
const m=require('mongoose');
const uri = process.env.MONGO_URI || 'mongodb+srv://amirashraf653_db_user:amirashraf12@cluster0.9v3tbgy.mongodb.net/MashawerrDB?retryWrites=true&w=majority&appName=Cluster0';
m.connect(uri).then(async()=>{
  const db=m.connection.db;
  const res=await db.collection('products').updateMany({deliveryPricePerMeter:100}, {$unset:{deliveryPricePerMeter:''}});
  console.log('Updated: ' + res.modifiedCount);
  
  // Also clear cart items to prevent them from having stale product data if any are cached
  await db.collection('carts').updateMany({}, {$set: {items: []}});
  console.log('Carts cleared to force refresh');
  
  process.exit(0);
});
