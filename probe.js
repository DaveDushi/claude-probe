#!/usr/bin/env node

const readline = require('node:readline');
const path = require('node:path');
const http = require('node:http');
const { exec } = require('node:child_process');

const args = process.argv.slice(2);
const isSendMode = args.includes('send');

// Parse flags
let port = 3456;
const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  port = parseInt(args[portIdx + 1], 10);
}

// ============================================================
// SEND MODE: lightweight stdin → POST to running server
// Usage: claude ... | node probe.js send [--port 3456]
// ============================================================
if (isSendMode) {
  const baseUrl = `http://localhost:${port}`;
  const connectionId = `conn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  function post(urlPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'X-Connection-Id': connectionId,
          ...headers,
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // Check if server is running via health endpoint
  async function checkServer() {
    return new Promise((resolve, reject) => {
      const url = new URL('/api/health', baseUrl);
      const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
        res.resume(); // drain
        resolve();
      });
      req.on('error', (err) => {
        if (err.code === 'ECONNREFUSED') {
          process.stderr.write(`\nclaude-probe: Server not running on port ${port}.\n`);
          process.stderr.write(`Start it first:  node probe.js [--port ${port}]\n\n`);
          process.exit(1);
        }
        reject(err);
      });
    });
  }

  async function main() {
    await checkServer();
    process.stderr.write(`claude-probe: Sending to localhost:${port}\n`);

    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    // Sequential send queue — guarantees ordering, limits concurrency to 1
    const queue = [];
    let sending = false;
    let lineCount = 0;
    let stdinClosed = false;
    let closeResolve = null;

    async function drain() {
      if (sending) return;
      sending = true;
      while (queue.length > 0) {
        const line = queue.shift();
        try {
          await post('/api/ingest', line);
        } catch {
          // Server went away mid-stream, keep draining to unblock close
        }
      }
      sending = false;
      // If stdin is closed and queue is empty, resolve the close promise
      if (stdinClosed && queue.length === 0 && closeResolve) {
        closeResolve();
      }
    }

    rl.on('line', (line) => {
      process.stdout.write(line + '\n');
      queue.push(line);
      lineCount++;
      drain();
    });

    rl.on('close', async () => {
      stdinClosed = true;
      // Wait for queue to fully drain
      if (queue.length > 0 || sending) {
        await new Promise(r => { closeResolve = r; });
      }
      try {
        const res = await post('/api/ingest/close', '');
        const result = JSON.parse(res.data);
        process.stderr.write(`claude-probe: Session saved as ${result.sessionId} (${lineCount} lines)\n`);
      } catch {
        process.stderr.write(`claude-probe: Session closed (${lineCount} lines)\n`);
      }
      process.exit(0);
    });
  }

  main();

// ============================================================
// SERVE MODE: persistent server (default)
// Usage: node probe.js [--port 3456] [--no-browser]
// ============================================================
} else {
  const { SessionStore } = require('./lib/store');
  const { createServer } = require('./lib/server');

  let dataDir = path.join(__dirname, 'sessions');
  const dataDirIdx = args.indexOf('--data-dir');
  if (dataDirIdx !== -1 && args[dataDirIdx + 1]) {
    dataDir = path.resolve(args[dataDirIdx + 1]);
  }

  const noBrowser = args.includes('--no-browser');
  const publicDir = path.join(__dirname, 'public');
  const store = new SessionStore(dataDir);
  const server = createServer(port, publicDir, store);

  server.start().then(() => {
    const url = `http://localhost:${port}`;
    const sessionCount = store.listSessions().length;

    process.stderr.write(`\nclaude-probe server running: ${url}\n`);
    process.stderr.write(`Sessions: ${dataDir} (${sessionCount} saved)\n`);
    process.stderr.write(`\nTo send sessions:\n`);
    process.stderr.write(`  claude -p "prompt" --output-format stream-json --verbose | node probe.js send\n\n`);

    if (!noBrowser) {
      const target = sessionCount > 0 ? `${url}/sessions.html` : url;
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
}
