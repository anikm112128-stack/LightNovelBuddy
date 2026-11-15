// Test-only static server. API requests are intercepted by the browser tests.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const files = { '/': 'index.html', '/index.html': 'index.html', '/script.js': 'script.js', '/style.css': 'style.css' };
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
http.createServer((req, res) => {
    const file = files[new URL(req.url, 'http://localhost').pathname];
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', types[path.extname(file)]);
    fs.createReadStream(path.join(__dirname, '..', file)).pipe(res);
}).listen(4173, '0.0.0.0');
