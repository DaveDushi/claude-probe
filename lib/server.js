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

function createServer(port, publicDir, store) {
  const clients = new Set();
  let stateSnapshot = null;

  const httpServer = http.createServer((req, res) => {
    const [urlPath, query] = req.url.split('?');

    // --- API routes ---
    if (urlPath === '/api/sessions' && req.method === 'GET') {
      const sessions = store.listSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
      return;
    }

    if (urlPath.startsWith('/api/sessions/') && req.method === 'GET') {
      const sessionId = decodeURIComponent(urlPath.slice('/api/sessions/'.length));
      const events = store.loadSession(sessionId);
      if (!events) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: sessionId, events }));
      return;
    }

    if (urlPath.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const sessionId = decodeURIComponent(urlPath.slice('/api/sessions/'.length));
      const deleted = store.deleteSession(sessionId);
      res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted }));
      return;
    }

    // --- Static file serving ---
    let filePath = urlPath === '/' ? '/index.html' : urlPath;
    filePath = path.join(publicDir, filePath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Prevent directory traversal
    const normalizedPublic = path.resolve(publicDir);
    const normalizedFile = path.resolve(filePath);
    if (!normalizedFile.startsWith(normalizedPublic)) {
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
