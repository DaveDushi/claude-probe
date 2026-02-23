#!/usr/bin/env node

const path = require('node:path');
const http = require('node:http');
const { exec } = require('node:child_process');

const args = process.argv.slice(2);

// Parse --port flag (global, works with any command)
let port = 3456;
const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  port = parseInt(args[portIdx + 1], 10);
  args.splice(portIdx, 2);
}

const command = args[0] || 'serve';
const BASE = `http://localhost:${port}`;

// ================================================================
// HTTP helpers
// ================================================================

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname + url.search }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    }).on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        process.stderr.write(`probe: Server not running on port ${port}. Start with: probe serve\n`);
        process.exit(1);
      }
      reject(err);
    });
  });
}

function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        process.stderr.write(`probe: Server not running on port ${port}. Start with: probe serve\n`);
        process.exit(1);
      }
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

function httpDelete(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'DELETE',
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ================================================================
// CLI helpers
// ================================================================

function getFlag(flag, argList) {
  argList = argList || args;
  const idx = argList.indexOf(flag);
  if (idx !== -1 && argList[idx + 1]) return argList[idx + 1];
  return null;
}

function hasFlag(flag, argList) {
  return (argList || args).includes(flag);
}

function formatDuration(ms) {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatCost(usd) {
  if (!usd) return '-';
  return `$${usd.toFixed(4)}`;
}

function truncate(str, len) {
  if (!str) return '';
  str = str.replace(/\n/g, ' ').trim();
  return str.length > len ? str.slice(0, len) + '...' : str;
}

// ================================================================
// Commands
// ================================================================

async function cmdServe() {
  const { SessionStore } = require('./lib/store');
  const { createServer } = require('./lib/server');

  let dataDir = path.join(__dirname, 'sessions');
  const dataDirFlag = getFlag('--data-dir');
  if (dataDirFlag) dataDir = path.resolve(dataDirFlag);

  const noBrowser = hasFlag('--no-browser');
  const publicDir = path.join(__dirname, 'public');
  const claudePath = getFlag('--claude-path');
  const store = new SessionStore(dataDir);
  const server = createServer(port, publicDir, store, { claudePath });

  await server.start();
  const url = `http://localhost:${port}`;
  const sessionCount = store.listSessions().length;

  process.stderr.write(`\nprobe server running: ${url}\n`);
  process.stderr.write(`sessions: ${dataDir} (${sessionCount} saved)\n\n`);

  if (!noBrowser) {
    const target = sessionCount > 0 ? `${url}/sessions.html` : url;
    if (process.platform === 'win32') exec(`start ${target}`);
    else if (process.platform === 'darwin') exec(`open ${target}`);
    else exec(`xdg-open ${target}`);
  }
}

async function cmdNew() {
  const prompt = getFlag('-p') || getFlag('--prompt');
  if (!prompt) {
    process.stderr.write('probe new: -p "prompt" required\n');
    process.exit(1);
  }

  const body = { prompt };
  const model = getFlag('--model');
  if (model) body.model = model;
  if (hasFlag('--auto-approve')) body.autoApprove = true;
  const cwd = getFlag('--cwd');
  if (cwd) body.cwd = path.resolve(cwd);
  const resume = getFlag('-r') || getFlag('--resume');
  if (resume) body.resumeSessionId = resume;
  // Collect passthrough flags for Claude CLI
  const flags = [];
  const permMode = getFlag('--permission-mode');
  if (permMode) flags.push('--permission-mode', permMode);
  const allowedTools = getFlag('--allowedTools') || getFlag('--allowed-tools');
  if (allowedTools) flags.push('--allowedTools', allowedTools);
  if (hasFlag('--dangerously-skip-permissions')) flags.push('--dangerously-skip-permissions');
  if (flags.length) body.flags = flags;

  const res = await httpPost('/api/sessions', body);
  if (res.status !== 200) {
    process.stderr.write(`probe new: ${res.data.error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write(`${res.data.sessionId}\n`);
}

async function cmdStatus() {
  const id = args[1];
  if (!id) { process.stderr.write('probe status: session ID required\n'); process.exit(1); }

  const res = await httpGet(`/api/sessions/${id}/status`);
  if (res.status !== 200) {
    process.stderr.write(`probe status: ${res.data.error || 'not found'}\n`);
    process.exit(1);
  }

  const s = res.data;
  let line = `status: ${s.status}`;
  if (s.phase && s.phase !== s.status) line += ` (${s.phase})`;
  if (s.model) line += ` | model: ${s.model}`;
  if (s.toolCalls) line += ` | tools: ${s.toolCalls}`;
  if (s.costUsd) line += ` | cost: ${formatCost(s.costUsd)}`;
  if (s.eventCount) line += ` | events: ${s.eventCount}`;
  process.stdout.write(line + '\n');

  if (s.stuckForMs && s.stuckForMs > 30000) {
    process.stdout.write(`warning: no activity for ${formatDuration(s.stuckForMs)}\n`);
  }

  if (s.pendingApproval) {
    const a = s.pendingApproval;
    let detail = `awaiting: ${a.toolName}`;
    if (a.requestedAt) {
      detail += ` (waiting ${formatDuration(Date.now() - a.requestedAt)})`;
    }
    if (a.input) {
      const inputStr = typeof a.input === 'string' ? a.input : JSON.stringify(a.input);
      detail += ` ${truncate(inputStr, 120)}`;
    }
    process.stdout.write(detail + '\n');
  }

  if (s.error) {
    const errLine = s.errorCode ? `error [${s.errorCode}]: ${s.error}` : `error: ${s.error}`;
    process.stdout.write(errLine + '\n');
  }
}

async function cmdEvents() {
  const id = args[1];
  if (!id) { process.stderr.write('probe events: session ID required\n'); process.exit(1); }

  const last = getFlag('--last') || '20';
  const res = await httpGet(`/api/sessions/${id}/events?last=${last}`);
  if (res.status !== 200) {
    process.stderr.write(`probe events: ${res.data.error || 'not found'}\n`);
    process.exit(1);
  }

  const events = res.data.events || [];
  for (const e of events) {
    const time = new Date(e.ts).toLocaleTimeString('en-US', { hour12: false });
    let line = `[${time}] `;

    switch (e.kind) {
      case 'init':
        line += `init model=${e.model}`;
        break;
      case 'text':
        line += `text: ${truncate(e.text, 120)}`;
        break;
      case 'text_delta':
        continue; // skip deltas in summary view
      case 'tool_call':
        line += `tool: ${e.toolName} ${truncate(typeof e.input === 'string' ? e.input : JSON.stringify(e.input), 100)}`;
        break;
      case 'tool_result':
        line += `result: ${truncate(e.content, 100)}${e.isError ? ' [ERROR]' : ''}`;
        break;
      case 'thinking':
        line += `thinking: ${truncate(e.text, 80)}`;
        break;
      case 'approval_request':
        line += `APPROVAL NEEDED: ${e.toolName} ${truncate(typeof e.input === 'string' ? e.input : JSON.stringify(e.input), 100)}`;
        break;
      case 'approval_granted':
        line += `APPROVED: ${e.toolName}`;
        break;
      case 'approval_denied':
        line += `DENIED: ${e.toolName}${e.message ? ` (${e.message})` : ''}`;
        break;
      case 'session_timeout':
        line += `TIMEOUT: ${e.reason} — ${e.message}`;
        break;
      case 'session_end':
        line += `end: ${e.isError ? 'ERROR' : 'ok'} cost=${formatCost(e.costUsd)} turns=${e.numTurns}`;
        break;
      case 'session_complete':
        line += `complete (${formatDuration(e.durationMs)})`;
        break;
      case 'session_resumed':
        line += `resumed`;
        break;
      case 'block_start':
        if (e.blockType === 'tool_use') {
          line += `tool_start: ${e.toolName}`;
        } else {
          continue; // skip text/thinking block_start
        }
        break;
      default:
        continue; // skip noisy events
    }

    process.stdout.write(line + '\n');
  }
}

async function cmdSend() {
  const id = args[1];
  if (!id) { process.stderr.write('probe send: session ID required\n'); process.exit(1); }

  const prompt = getFlag('-p') || getFlag('--prompt');
  if (!prompt) { process.stderr.write('probe send: -p "prompt" required\n'); process.exit(1); }

  const res = await httpPost(`/api/sessions/${id}/message`, { prompt });
  if (res.status !== 200) {
    process.stderr.write(`probe send: ${res.data.error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write(`sent (${res.data.status})\n`);
}

async function cmdApprove() {
  const id = args[1];
  if (!id) { process.stderr.write('probe approve: session ID required\n'); process.exit(1); }

  const res = await httpPost(`/api/sessions/${id}/approve`, {});
  if (res.status !== 200) {
    process.stderr.write(`probe approve: ${res.data.error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write('approved\n');
}

async function cmdDeny() {
  const id = args[1];
  if (!id) { process.stderr.write('probe deny: session ID required\n'); process.exit(1); }

  const message = getFlag('-m') || getFlag('--message') || '';
  const res = await httpPost(`/api/sessions/${id}/deny`, { message });
  if (res.status !== 200) {
    process.stderr.write(`probe deny: ${res.data.error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write('denied\n');
}

async function cmdClose() {
  const id = args[1];
  if (!id) { process.stderr.write('probe close: session ID required\n'); process.exit(1); }

  const res = await httpPost(`/api/sessions/${id}/close`, {});
  if (res.status !== 200) {
    process.stderr.write(`probe close: ${res.data.error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write(`closed${res.data.wasActive ? '' : ' (was already done)'}\n`);
}

async function cmdShutdown() {
  const res = await httpPost('/api/shutdown', {});
  if (res.status !== 200) {
    process.stderr.write(`probe shutdown: ${res.data.error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write('server stopped\n');
}

async function cmdResult() {
  const id = args[1];
  if (!id) { process.stderr.write('probe result: session ID required\n'); process.exit(1); }

  const res = await httpGet(`/api/sessions/${id}/result`);
  if (res.status !== 200) {
    process.stderr.write(`probe result: ${res.data.error || 'not found'}\n`);
    process.exit(1);
  }

  if (res.data.result) {
    process.stdout.write(res.data.result + '\n');
  } else if (res.data.status && res.data.status !== 'done') {
    process.stdout.write(`(session still ${res.data.status})\n`);
  } else {
    process.stdout.write('(no result)\n');
  }
}

async function cmdSessions() {
  const res = await httpGet('/api/sessions');
  if (res.status !== 200) {
    process.stderr.write('probe sessions: failed to list\n');
    process.exit(1);
  }

  const sessions = res.data || [];
  if (sessions.length === 0) {
    process.stdout.write('no sessions\n');
    return;
  }

  for (const s of sessions) {
    let line = `${s.id}`;
    if (s.status) line += ` [${s.status}]`;
    else if (s.ended) line += ' [done]';
    if (s.model) line += ` ${s.model}`;
    if (s.costUsd) line += ` ${formatCost(s.costUsd)}`;
    if (s.toolCalls) line += ` ${s.toolCalls}tools`;
    if (s.preview) line += ` "${truncate(s.preview, 60)}"`;
    process.stdout.write(line + '\n');
  }
}

async function cmdDoctor() {
  // Step 1: Check server reachability
  let healthOk = false;
  try {
    const health = await httpGet('/api/health');
    healthOk = health.status === 200 && health.data.ok;
    process.stdout.write(`server: ${healthOk ? 'OK' : 'UNHEALTHY'} (port ${port})\n`);
    process.stdout.write(`  active sessions: ${health.data.activeSessions}\n`);
  } catch (err) {
    process.stdout.write(`server: UNREACHABLE (port ${port})\n`);
    process.stdout.write(`  ${err.message}\n`);
    process.exit(1);
  }

  // Step 2: Detailed diagnostics
  try {
    const diag = await httpGet('/api/diagnostics');
    if (diag.status === 200) {
      const d = diag.data;
      process.stdout.write(`  uptime: ${formatDuration(d.serverUptime * 1000)}\n`);
      process.stdout.write(`  dashboard clients: ${d.dashboardClients}\n`);
      process.stdout.write(`  watchdog tracking: ${d.watchdogTracking}\n`);

      if (d.sessions && d.sessions.length > 0) {
        process.stdout.write(`\nsessions:\n`);
        for (const s of d.sessions) {
          let line = `  ${s.sessionId} [${s.status}]`;
          line += ` proc=${s.processAlive ? 'alive' : 'dead'}`;
          line += ` ws=${s.wsConnected ? 'connected' : 'disconnected'}`;
          line += ` events=${s.eventCount}`;
          if (s.stuckForMs && s.stuckForMs > 10000) {
            line += ` stuck=${formatDuration(s.stuckForMs)}`;
          }
          if (s.error) line += ` error="${s.error}"`;
          process.stdout.write(line + '\n');
        }
      }
    }
  } catch {
    process.stdout.write('  (diagnostics endpoint not available)\n');
  }

  // Step 3: Quick WebSocket test
  try {
    const WebSocket = require('ws');
    await new Promise((resolve, reject) => {
      const testWs = new WebSocket(`ws://localhost:${port}`);
      const timer = setTimeout(() => {
        testWs.close();
        reject(new Error('timeout'));
      }, 5000);
      testWs.on('open', () => {
        clearTimeout(timer);
        testWs.close();
        resolve();
      });
      testWs.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    process.stdout.write(`websocket: OK\n`);
  } catch (err) {
    process.stdout.write(`websocket: FAILED (${err.message})\n`);
  }
}

function printUsage() {
  process.stderr.write(`
claude-probe - control Claude Code sessions

Commands:
  serve                         Start the server + dashboard
  new -p "prompt" [opts]        Create session (returns ID)
  status <id>                   Get session status
  events <id> [--last N]        Get recent events
  send <id> -p "prompt"         Send follow-up message
  close <id>                    Close session (kill process, keep data)
  shutdown                      Stop the server and free the port
  approve <id>                  Approve pending tool use
  deny <id> [-m "reason"]       Deny pending tool use
  result <id>                   Get final result text
  sessions                      List all sessions
  doctor                        Server/session health diagnostics

Options for 'new':
  --model <model>               Claude model to use
  --auto-approve                Auto-approve all tool use
  --cwd <dir>                   Working directory
  -r, --resume <session-id>     Resume a Claude session

Global:
  --port <port>                 Server port (default: 3456)

`);
}

// ================================================================
// Dispatch
// ================================================================

switch (command) {
  case 'serve':
  case 'start':
    cmdServe();
    break;
  case 'new':
  case 'create':
    cmdNew();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'events':
  case 'log':
    cmdEvents();
    break;
  case 'send':
  case 'message':
    cmdSend();
    break;
  case 'close':
    cmdClose();
    break;
  case 'shutdown':
  case 'stop':
    cmdShutdown();
    break;
  case 'approve':
    cmdApprove();
    break;
  case 'deny':
    cmdDeny();
    break;
  case 'result':
    cmdResult();
    break;
  case 'sessions':
  case 'list':
  case 'ls':
    cmdSessions();
    break;
  case 'doctor':
  case 'diag':
    cmdDoctor();
    break;
  case 'help':
  case '--help':
  case '-h':
    printUsage();
    break;
  default:
    // No args → serve
    if (!command || command.startsWith('-')) {
      cmdServe();
    } else {
      process.stderr.write(`probe: unknown command '${command}'\n`);
      printUsage();
      process.exit(1);
    }
}
