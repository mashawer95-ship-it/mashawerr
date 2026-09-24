const fs = require('fs');
const http = require('http');

const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY2NWYxYTJiM2M0ZDVlNmY3YThiOWMwZCIsImlzQWRtaW4iOnRydWUsInVzZXJUeXBlIjoiQWRtaW4iLCJpYXQiOjE3NzgzNTk2MzV9.svmMNYSxm9RjW7H5_E-2gLXW57q-5cvYSfKm1gV90-U';

const postData = `--${boundary}\r\n` +
                 `Content-Disposition: form-data; name="name"\r\n\r\n` +
                 `Wireless Headphones\r\n` +
                 `--${boundary}\r\n` +
                 `Content-Disposition: form-data; name="price"\r\n\r\n` +
                 `3\r\n` +
                 `--${boundary}\r\n` +
                 `Content-Disposition: form-data; name="stock"\r\n\r\n` +
                 `50\r\n` +
                 `--${boundary}--\r\n`;

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/store/products',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': Buffer.byteLength(postData)
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => console.log(`STATUS: ${res.statusCode}\nBODY: ${data}`));
});

req.on('error', (e) => console.error(`problem with request: ${e.message}`));
req.write(postData);
req.end();
