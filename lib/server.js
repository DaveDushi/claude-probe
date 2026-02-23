const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function createServer(port, publicDir) {
  const clients = new Set();
  let stateSnapshot = null;

  const httpServer = http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.join(publicDir, urlPath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Prevent directory traversal
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    clients.add(ws);

    // Send current state snapshot to new client
    if (stateSnapshot) {
      ws.send(JSON.stringify({ type: 'snapshot', data: stateSnapshot() }));
    }

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  function broadcast(event) {
    const msg = JSON.stringify({ type: 'event', data: event });
    for (const ws of clients) {
      if (ws.readyState === 1) { // OPEN
        ws.send(msg);
      }
    }
  }

  function setSnapshotProvider(fn) {
    stateSnapshot = fn;
  }

  function start() {
    return new Promise((resolve) => {
      httpServer.listen(port, () => resolve());
    });
  }

  return { start, broadcast, setSnapshotProvider, httpServer };
}

module.exports = { createServer };
