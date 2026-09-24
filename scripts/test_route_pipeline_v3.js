/**
 * test_route_pipeline_v3.js
 * Verification script for Route Pipeline v3 (Mashawerr)
 */

const { buildRouteCacheKey } = require('../utils/routeCacheKey');
const { SimpleCircuitBreaker } = require('../utils/circuitBreaker');
const { memoryRouteCache, getRouteFromAllLayers } = require('../services/memoryRouteCache');
const { checkOffRoute } = require('../utils/offRouteDetector');
const metrics = require('../utils/metrics');

async function runTests() {
    console.log('--- Step 1: Testing Cache Key Builder (Geohash precision 7) ---');
    const key1 = buildRouteCacheKey({
        originLat: 30.0444, originLng: 31.2357,
        destLat: 30.0500, destLng: 31.2400,
    });
    console.log('Cache Key 1:', key1);
    if (!key1.startsWith('route_geo:')) throw new Error('Invalid Cache Key prefix');

    console.log('\n--- Step 2: Testing Circuit Breaker ---');
    const cb = new SimpleCircuitBreaker();
    for (let i = 0; i < 5; i++) cb.recordFailure('google');
    if (!cb.isOpen('google')) throw new Error('Circuit Breaker should be OPEN after 5 failures');
    console.log('Circuit Breaker Status:', cb.isOpen('google') ? 'OPEN (Correct)' : 'CLOSED');
    cb.recordSuccess('google');
    if (cb.isOpen('google')) throw new Error('Circuit Breaker should be CLOSED after success');
    console.log('Circuit Breaker Status after success:', 'CLOSED (Correct)');

    console.log('\n--- Step 3: Testing Memory LRU Cache Layer ---');
    const testKey = 'route_geo:test_o:test_d:drive:traffic_aware:car:tolls:hwy:ar';
    const mockData = { encodedPolyline: 'test_poly', distanceMeters: 1000, durationSeconds: 120 };
    
    // Warm memory cache
    memoryRouteCache.set(testKey, mockData);
    const result = await getRouteFromAllLayers(testKey, () => {
        throw new Error('Should not call fetchFn when in memory');
    });

    console.log('Fetched layer:', result.cacheLayer, '| fromCache:', result.fromCache);
    if (result.cacheLayer !== 'memory') throw new Error('Expected memory cache hit');

    console.log('\n--- Step 4: Testing Off-Route Threshold & Immediate Bypass ---');
    const points = [
        { lat: 30.0444, lng: 31.2357 },
        { lat: 30.0450, lng: 31.2360 },
    ];

    // Near point (~5m away)
    const res1 = checkOffRoute('trip_1', { lat: 30.04441, lng: 31.23571 }, points);
    console.log('Near point offRoute:', res1.isOffRoute, '| dist:', res1.distanceFromRoute.toFixed(1) + 'm');
    if (res1.isOffRoute) throw new Error('Should not be off route for 5m distance');

    // Moderate off route (60m away -> off route, but not immediate)
    const res2 = checkOffRoute('trip_1', { lat: 30.0450, lng: 31.2366 }, points);
    console.log('60m offRoute:', res2.isOffRoute, '| immediate:', res2.isImmediate, '| dist:', res2.distanceFromRoute.toFixed(1) + 'm');
    if (!res2.isOffRoute || res2.isImmediate) throw new Error('Expected normal off route (not immediate)');

    // Large deviation (200m away -> immediate reroute)
    const res3 = checkOffRoute('trip_1', { lat: 30.0450, lng: 31.2380 }, points);
    console.log('200m offRoute:', res3.isOffRoute, '| immediate:', res3.isImmediate, '| dist:', res3.distanceFromRoute.toFixed(1) + 'm');
    if (!res3.isImmediate) throw new Error('Expected immediate reroute for >150m deviation');

    console.log('\n--- Step 5: Testing Metrics Aggregate Calculation ---');
    metrics.increment('memory_cache_hit', 10);
    metrics.increment('redis_cache_hit', 5);
    metrics.increment('active_route_cache_hit', 15);
    metrics.increment('google_api_calls', 2);
    
    const summary = await metrics.getAggregateMetrics();
    console.log('Metrics Summary:', JSON.stringify(summary, null, 2));

    console.log('\n✅ ALL VERIFICATION TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
