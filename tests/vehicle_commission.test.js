const assert = require('assert');
const {
    validateUpdateRepCommission,
    resolveOrderRepCommissionPctSync,
    resolveOrderRepCommissionPct,
} = require('../middlewares/RepCommission');

async function runVehicleCommissionTests() {
    console.log('--- Starting Vehicle Commission Tests ---');

    // 1. Test validateUpdateRepCommission
    const validPayload = {
        deliveryRepCommissionPct: 70,
        passengerRepCommissionPct: 80,
        deliveryVehicleCommissions: [
            { vehicleTypeId: '660000000000000000000001', name_ar: 'موتوسيكل', commissionPct: 60 },
            { vehicleTypeId: '660000000000000000000002', name_ar: 'سيارة', commissionPct: 75 },
        ],
        passengerVehicleCommissions: [
            { vehicleTypeId: '660000000000000000000002', name_ar: 'سيارة ملاكي', commissionPct: 85 },
            { vehicleTypeId: '660000000000000000000003', name_ar: 'سكوتر', commissionPct: 90 },
        ],
    };
    const { error: validErr, value: validated } = validateUpdateRepCommission(validPayload);
    assert.strictEqual(validErr, undefined, 'Valid payload must pass validation');
    assert.strictEqual(validated.deliveryRepCommissionPct, 70);
    assert.strictEqual(validated.deliveryVehicleCommissions.length, 2);
    console.log('✅ validateUpdateRepCommission passes for valid payload');

    // Validation rejects negative percentage
    const invalidPayload = {
        deliveryVehicleCommissions: [
            { vehicleTypeId: '123', commissionPct: -5 }
        ]
    };
    const { error: invalidErr } = validateUpdateRepCommission(invalidPayload);
    assert.ok(invalidErr, 'Negative commissionPct must fail validation');
    console.log('✅ validateUpdateRepCommission rejects negative commissionPct');

    // 2. Test resolveOrderRepCommissionPctSync
    const commissionCfg = {
        deliveryRepCommissionPct: 70,
        passengerRepCommissionPct: 80,
        deliveryVehicleCommissions: [
            { vehicleTypeId: 'vt_moto', name_ar: 'موتوسيكل', commissionPct: 60 },
            { vehicleTypeId: 'vt_car', name_ar: 'سيارة', commissionPct: 75 },
        ],
        passengerVehicleCommissions: [
            { vehicleTypeId: 'vt_car', name_ar: 'سيارة ملاكي', commissionPct: 85 },
            { vehicleTypeId: 'vt_scooter', name_ar: 'سكوتر', commissionPct: 90 },
        ],
    };

    // Case A: Delivery order with motorcycle rep (should get 60%)
    const deliveryOrderWithMoto = {
        orderCategory: 'delivery',
        vehicleTypeId: 'vt_moto',
    };
    const motoPct = resolveOrderRepCommissionPctSync({ order: deliveryOrderWithMoto, commissionCfg });
    assert.strictEqual(motoPct, 60, 'Motorcycle in delivery should get 60%');
    console.log('✅ Motorcycle delivery gets 60% rep share (company takes 40%)');

    // Case B: Delivery order with car rep (should get 75%)
    const deliveryOrderWithCar = {
        orderCategory: 'delivery',
        vehicleTypeId: 'vt_car',
    };
    const carPct = resolveOrderRepCommissionPctSync({ order: deliveryOrderWithCar, commissionCfg });
    assert.strictEqual(carPct, 75, 'Car in delivery should get 75%');
    console.log('✅ Car delivery gets 75% rep share (company takes 25%)');

    // Case C: Delivery order without vehicle on order, but rep has motorcycle
    const deliveryOrderNoVehicle = {
        orderCategory: 'delivery',
    };
    const repWithMoto = {
        vehicleTypeId: 'vt_moto',
        vehicleTypeName: 'موتوسيكل',
    };
    const resolvedFromRep = resolveOrderRepCommissionPctSync({
        order: deliveryOrderNoVehicle,
        repUser: repWithMoto,
        commissionCfg,
    });
    assert.strictEqual(resolvedFromRep, 60, 'Order without vehicle should resolve from rep vehicle (60%)');
    console.log('✅ Order without vehicle on order resolves from repUser (60%)');

    // Case D: Passenger ride with car (should get 85%)
    const passengerRideWithCar = {
        orderCategory: 'passenger',
        vehicleTypeId: 'vt_car',
    };
    const passCarPct = resolveOrderRepCommissionPctSync({ order: passengerRideWithCar, commissionCfg });
    assert.strictEqual(passCarPct, 85, 'Car in passenger should get 85%');
    console.log('✅ Car in passenger ride gets 85% rep share (company takes 15%)');

    // Case E: Passenger ride with scooter (should get 90%)
    const passengerRideWithScooter = {
        orderCategory: 'passenger',
        vehicleTypeId: 'vt_scooter',
    };
    const passScooterPct = resolveOrderRepCommissionPctSync({ order: passengerRideWithScooter, commissionCfg });
    assert.strictEqual(passScooterPct, 90, 'Scooter in passenger should get 90%');
    console.log('✅ Scooter in passenger ride gets 90% rep share (company takes 10%)');

    // Case F: Vehicle not in custom list should fall back to general category percentage
    const deliveryUnknownVehicle = {
        orderCategory: 'delivery',
        vehicleTypeId: 'vt_truck',
    };
    const fallbackDeliveryPct = resolveOrderRepCommissionPctSync({ order: deliveryUnknownVehicle, commissionCfg });
    assert.strictEqual(fallbackDeliveryPct, 70, 'Unknown vehicle in delivery should fall back to general 70%');
    console.log('✅ Unknown vehicle falls back to general category percentage (70%)');

    // Case G: Company deduction calculation
    // e.g. Order delivery price = 100 EGP (100000 Fils)
    // Motorcycle: rep = 60%, company = 40% (40000 Fils / 40 EGP)
    const deliveryPriceFils = 100000;
    const companyPct = 100 - motoPct; // 40
    const companyFeeFils = Math.round((deliveryPriceFils * companyPct) / 100);
    assert.strictEqual(companyFeeFils, 40000, 'Company fee for 100 EGP at 40% company commission must be 40000 Fils (40 EGP)');
    console.log('✅ Company commission deduction math is exact: 100 EGP -> 40 EGP company fee');

    console.log('🎉 All Vehicle Commission unit tests PASSED successfully!');
}

runVehicleCommissionTests().catch((err) => {
    console.error('❌ Vehicle Commission Tests Failed:', err);
    process.exit(1);
});
