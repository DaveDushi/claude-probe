const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { parseLine } = require('./parser');
const { SessionState } = require('./state');

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

  // --- Ingest session management ---
  // connectionId → { sessionId, state }
  const ingestSessions = new Map();
  let activeConnectionId = null;

  function getOrCreateIngest(connectionId) {
    if (ingestSessions.has(connectionId)) return ingestSessions.get(connectionId);
    const ctx = { sessionId: null, state: new SessionState() };
    ingestSessions.set(connectionId, ctx);
    activeConnectionId = connectionId;
    return ctx;
  }

  function handleIngestLine(connectionId, rawLine) {
    const ctx = getOrCreateIngest(connectionId);
    const events = parseLine(rawLine);

    for (const event of events) {
      // On init event, determine session ID and check for resume
      if (event.kind === 'init' && event.sessionId) {
        if (store.hasSession(event.sessionId)) {
          ctx.sessionId = event.sessionId;
          const existing = store.loadSession(ctx.sessionId);
          if (existing) {
            for (const e of existing) ctx.state.addEvent(e);
          }
          const resumeEvent = {
            id: `evt_${Date.now()}_resume`,
            ts: Date.now(),
            kind: 'session_resumed',
            sessionId: event.sessionId,
          };
          ctx.state.addEvent(resumeEvent);
          store.appendEvent(ctx.sessionId, resumeEvent);
          broadcast(resumeEvent);
        } else {
          ctx.sessionId = event.sessionId;
        }
      }

      if (!ctx.sessionId) {
        ctx.sessionId = store.generateSessionId();
      }

      ctx.state.addEvent(event);
      store.appendEvent(ctx.sessionId, event);
      broadcast(event);
    }
  }

  function closeIngest(connectionId) {
    const ctx = ingestSessions.get(connectionId);
    if (!ctx) return null;

    const endEvent = {
      id: `evt_${Date.now()}_end`,
      ts: Date.now(),
      kind: 'session_complete',
      durationMs: Date.now() - ctx.state.startTime,
    };
    ctx.state.addEvent(endEvent);
    if (ctx.sessionId) {
      store.appendEvent(ctx.sessionId, endEvent);
    }
    broadcast(endEvent);

    const sessionId = ctx.sessionId;
    ingestSessions.delete(connectionId);
    if (activeConnectionId === connectionId) {
      // Switch to another active connection or null
      activeConnectionId = ingestSessions.size > 0
        ? [...ingestSessions.keys()].pop()
        : null;
    }
    return sessionId;
  }

  // Snapshot provider: returns the active ingest session's state
  function getSnapshot() {
    if (activeConnectionId && ingestSessions.has(activeConnectionId)) {
      return ingestSessions.get(activeConnectionId).state.getSnapshot();
    }
    return null;
  }

  // --- Helper to read request body ---
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    const [urlPath] = req.url.split('?');

    // --- CORS for local dev ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Connection-Id');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // --- Health check ---
    if (urlPath === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, connections: ingestSessions.size }));
      return;
    }

    // --- Ingest API ---
    if (urlPath === '/api/ingest' && req.method === 'POST') {
      const connectionId = req.headers['x-connection-id'];
      if (!connectionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing X-Connection-Id header' }));
        return;
      }
      try {
        const body = await readBody(req);
        handleIngestLine(connectionId, body.trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (urlPath === '/api/ingest/close' && req.method === 'POST') {
      const connectionId = req.headers['x-connection-id'];
      if (!connectionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing X-Connection-Id header' }));
        return;
      }
      const sessionId = closeIngest(connectionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ closed: true, sessionId }));
      return;
    }

    // --- Sessions API ---
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

    const snap = getSnapshot();
    if (snap) {
      ws.send(JSON.stringify({ type: 'snapshot', data: snap }));
    }

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  function broadcast(event) {
    const msg = JSON.stringify({ type: 'event', data: event });
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }

  function start() {
    return new Promise((resolve) => {
      httpServer.listen(port, () => resolve());
    });
  }

  return { start, broadcast, getSnapshot, httpServer };
}

module.exports = { createServer };
