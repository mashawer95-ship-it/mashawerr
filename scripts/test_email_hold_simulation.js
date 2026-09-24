const mockSub1Pending = { status: 'delivered' };
const mockSub2Pending = { status: 'delivering' };
const mockSub2Delivered = { status: 'delivered' };

// Test 1: Sub 1 delivered, Sub 2 pending
const subs1 = [mockSub1Pending, mockSub2Pending];
const allDone1 = subs1.length === 0 || subs1.every(s => ['delivered', 'completed', 'done'].includes(String(s.status).toLowerCase()));

// Test 2: Both Sub 1 and Sub 2 delivered
const subs2 = [mockSub1Pending, mockSub2Delivered];
const allDone2 = subs2.length === 0 || subs2.every(s => ['delivered', 'completed', 'done'].includes(String(s.status).toLowerCase()));

console.log('--- 🧪 Test Email Hold Simulation ---');
console.log('1. Email held when Sub 2 is pending (allDone1 === false):', allDone1 === false);
console.log('2. Email sent when both Sub 1 & Sub 2 delivered (allDone2 === true):', allDone2 === true);
