#!/usr/bin/env node

const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const { exec } = require('node:child_process');
const { parseLine } = require('./lib/parser');
const { SessionState } = require('./lib/state');
const { SessionStore } = require('./lib/store');
const { createServer } = require('./lib/server');

const args = process.argv.slice(2);

// Parse flags
let port = 3456;
const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  port = parseInt(args[portIdx + 1], 10);
}

let dataDir = path.join(__dirname, 'sessions');
const dataDirIdx = args.indexOf('--data-dir');
if (dataDirIdx !== -1 && args[dataDirIdx + 1]) {
  dataDir = path.resolve(args[dataDirIdx + 1]);
}

const noBrowser = args.includes('--no-browser');

const publicDir = path.join(__dirname, 'public');
const store = new SessionStore(dataDir);
const state = new SessionState();
const server = createServer(port, publicDir, store);

server.setSnapshotProvider(() => state.getSnapshot());

// Detect if stdin is piped (capture mode) or terminal (browse mode)
const isPiped = !process.stdin.isTTY;

if (isPiped) {
  // --- CAPTURE MODE ---
  // Pipe from Claude Code → parse → persist → broadcast
  let currentSessionId = null;
  let sessionIdFromClaude = null;

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', (line) => {
    const events = parseLine(line);
    for (const event of events) {
      // On init event, determine session ID and check for resume
      if (event.kind === 'init' && event.sessionId) {
        sessionIdFromClaude = event.sessionId;

        if (store.hasSession(event.sessionId)) {
          // Resume: append to existing session
          currentSessionId = event.sessionId;
          // Load existing events into state for snapshot continuity
          const existing = store.loadSession(currentSessionId);
          if (existing) {
            for (const e of existing) state.addEvent(e);
          }
          // Add a resume marker
          const resumeEvent = {
            id: `evt_${Date.now()}_resume`,
            ts: Date.now(),
            kind: 'session_resumed',
            sessionId: event.sessionId,
          };
          state.addEvent(resumeEvent);
          store.appendEvent(currentSessionId, resumeEvent);
          server.broadcast(resumeEvent);

          process.stderr.write(`claude-probe: Resuming session ${currentSessionId}\n`);
        } else {
          // New session — use Claude's session ID as the file name
          currentSessionId = event.sessionId;
        }
      }

      // If no session ID yet, generate one
      if (!currentSessionId) {
        currentSessionId = store.generateSessionId();
      }

      state.addEvent(event);
      store.appendEvent(currentSessionId, event);
      server.broadcast(event);
    }
  });

  rl.on('close', () => {
    const endEvent = {
      id: `evt_${Date.now()}_end`,
      ts: Date.now(),
      kind: 'session_complete',
      durationMs: Date.now() - state.startTime,
    };
    state.addEvent(endEvent);
    if (currentSessionId) {
      store.appendEvent(currentSessionId, endEvent);
      process.stderr.write(`\nclaude-probe: Session saved as ${currentSessionId}\n`);
    }
    server.broadcast(endEvent);
    process.stderr.write('claude-probe: Dashboard still running. Press Ctrl+C to exit.\n');
  });
}

server.start().then(() => {
  const url = `http://localhost:${port}`;

  if (isPiped) {
    process.stderr.write(`\nclaude-probe dashboard: ${url}\n`);
  } else {
    // Browse mode — no pipe, just serve the session browser
    process.stderr.write(`\nclaude-probe session browser: ${url}/sessions.html\n`);
    process.stderr.write(`Sessions stored in: ${dataDir}\n`);
    process.stderr.write(`${store.listSessions().length} saved session(s) found.\n`);
    process.stderr.write('Press Ctrl+C to exit.\n');
  }

  // Auto-open browser
  if (!noBrowser) {
    const target = isPiped ? url : `${url}/sessions.html`;
    const platform = process.platform;
    if (platform === 'win32') {
      exec(`start ${target}`);
    } else if (platform === 'darwin') {
      exec(`open ${target}`);
    } else {
      exec(`xdg-open ${target}`);
    }
  }
});
