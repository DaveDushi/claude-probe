#!/usr/bin/env node

const readline = require('node:readline');
const path = require('node:path');
const { exec } = require('node:child_process');
const { parseLine } = require('./lib/parser');
const { SessionState } = require('./lib/state');
const { createServer } = require('./lib/server');

const args = process.argv.slice(2);
let port = 3456;

// Parse --port flag
const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  port = parseInt(args[portIdx + 1], 10);
}

const publicDir = path.join(__dirname, 'public');
const state = new SessionState();
const server = createServer(port, publicDir);

server.setSnapshotProvider(() => state.getSnapshot());

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on('line', (line) => {
  const events = parseLine(line);
  for (const event of events) {
    state.addEvent(event);
    server.broadcast(event);
  }
});

rl.on('close', () => {
  // stdin closed — Claude Code finished
  const endEvent = {
    id: `evt_${Date.now()}_end`,
    ts: Date.now(),
    kind: 'session_complete',
    durationMs: Date.now() - state.startTime,
  };
  state.addEvent(endEvent);
  server.broadcast(endEvent);
  process.stderr.write('\nclaude-probe: Session complete. Dashboard still running. Press Ctrl+C to exit.\n');
});

server.start().then(() => {
  const url = `http://localhost:${port}`;
  process.stderr.write(`\nclaude-probe dashboard: ${url}\n`);

  // Auto-open browser
  const platform = process.platform;
  if (platform === 'win32') {
    exec(`start ${url}`);
  } else if (platform === 'darwin') {
    exec(`open ${url}`);
  } else {
    exec(`xdg-open ${url}`);
  }
});
