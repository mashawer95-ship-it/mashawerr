console.log('--- Testing StoreOrder price normalization logic (All prices in Fils down to 1 fil precision) ---');

function normalizeToFils(val) {
    let d = Number(val);
    if (isNaN(d) || d <= 0) return 0;
    return Math.round(d);
}

function filsToKD(val) {
    const fils = normalizeToFils(val);
    return Number((fils / 1000).toFixed(3));
}

const cases = [
    { inputFils: 1000000, expectedFils: 1000000, expectedKD: 1000.0 }, // 1000 Dinars
    { inputFils: 1000, expectedFils: 1000, expectedKD: 1.0 },         // 1 Dinar
    { inputFils: 1898.9, expectedFils: 1899, expectedKD: 1.899 },      // 1.8989 Dinars rounded to 1 fil
    { inputFils: 1899, expectedFils: 1899, expectedKD: 1.899 },        // 1.899 Dinars
    { inputFils: 500, expectedFils: 500, expectedKD: 0.5 },            // Half Dinar (500 fils)
    { inputFils: 1, expectedFils: 1, expectedKD: 0.001 },              // 1 fil
    { inputFils: 0, expectedFils: 0, expectedKD: 0 },                  // 0
];

let allPassed = true;
cases.forEach(({ inputFils, expectedFils, expectedKD }) => {
    const actualFils = normalizeToFils(inputFils);
    const actualKD = filsToKD(inputFils);
    const pass = actualFils === expectedFils && actualKD === expectedKD;
    console.log(`Input: ${inputFils} -> Fils: ${actualFils} (Expected: ${expectedFils}), KD: ${actualKD} (Expected: ${expectedKD}) => ${pass ? '✅ PASS' : '❌ FAIL'}`);
    if (!pass) allPassed = false;
});

if (!allPassed) {
    console.error('Some tests failed!');
    process.exit(1);
} else {
    console.log('All normalization tests passed! 🎉');
    process.exit(0);
}
