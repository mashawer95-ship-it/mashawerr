const http = require('http');

http.get('http://localhost:3000/api/discounts/global-active', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => console.log("Localhost Response:", data));
}).on('error', (err) => console.error("Localhost error:", err.message));

const https = require('https');
https.get('https://mashawerr-api.onrender.com/api/discounts/global-active', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => console.log("Render Response:", data));
}).on('error', (err) => console.error("Render error:", err.message));
