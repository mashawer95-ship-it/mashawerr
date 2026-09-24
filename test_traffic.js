require('dotenv').config();
const axios = require('axios');

async function test() {
    const origin = { lat: 26.3374136, lng: 31.8888655 };
    const destination = { lat: 26.3393854, lng: 31.886221 };

    const requestBody = {
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        polylineQuality: 'HIGH_QUALITY',
        extraComputations: ["TRAFFIC_ON_POLYLINE"]
    };

    try {
        const response = await axios.post('https://routes.googleapis.com/directions/v2:computeRoutes', requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': process.env.GOOGLE_ROUTES_API_KEY,
                'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration,routes.travelAdvisory.speedReadingIntervals',
            }
        });
        
        console.log("Distance:", response.data.routes[0].distanceMeters);
        console.log("Traffic Intervals:", JSON.stringify(response.data.routes[0].travelAdvisory, null, 2));
    } catch (e) {
        console.error(e.response ? e.response.data : e.message);
    }
}
test();
