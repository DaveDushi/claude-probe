import path from 'node:path';
import http from 'node:http';
import { exec } from 'node:child_process';

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

interface HttpResponse {
  status: number;
  data: Record<string, unknown> | string;
}

function httpGet(urlPath: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    http.get({ hostname: url.hostname, port: url.port, path: url.pathname + url.search }, (res) => {
      let data = '';
      res.on('data', (c: Buffer | string) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, data }); }
      });
    }).on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        process.stderr.write(`probe: Server not running on port ${port}. Start with: probe serve\n`);
        process.exit(1);
      }
      reject(err);
    });
  });
}

function httpPost(urlPath: string, body: unknown): Promise<HttpResponse> {
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
      res.on('data', (c: Buffer | string) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, data }); }
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
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

function httpDelete(urlPath: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'DELETE',
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer | string) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ================================================================
// CLI helpers
// ================================================================

function getFlag(flag: string, argList?: string[]): string | null {
  const list = argList || args;
  const idx = list.indexOf(flag);
  if (idx !== -1 && list[idx + 1]) return list[idx + 1];
  return null;
}

function hasFlag(flag: string, argList?: string[]): boolean {
  return (argList || args).includes(flag);
}

function formatDuration(ms: number): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatCost(usd: number): string {
  if (!usd) return '-';
  return `$${usd.toFixed(4)}`;
}

function truncate(str: string, len: number): string {
  if (!str) return '';
  str = str.replace(/\n/g, ' ').trim();
  return str.length > len ? str.slice(0, len) + '...' : str;
}

// Helper to safely get data as record
function asRecord(data: unknown): Record<string, unknown> {
  return data as Record<string, unknown>;
}

// ================================================================
// Commands
// ================================================================

async function cmdServe(): Promise<void> {
  const { SessionStore } = await import('./lib/store');
  const { createServer } = await import('./lib/server');

  let dataDir = path.join(__dirname, '..', 'sessions');
  const dataDirFlag = getFlag('--data-dir');
  if (dataDirFlag) dataDir = path.resolve(dataDirFlag);

  const noBrowser = hasFlag('--no-browser');
  const publicDir = path.join(__dirname, '..', 'public');
  const claudePath = getFlag('--claude-path');
  // Parse global limit flags
  const limits: Record<string, number> = {};
  const maxCost = getFlag('--max-cost');
  if (maxCost) limits.maxCostUsd = parseFloat(maxCost);
  const maxTurns = getFlag('--max-turns');
  if (maxTurns) limits.maxTurns = parseInt(maxTurns, 10);
  const maxDuration = getFlag('--max-duration');
  if (maxDuration) limits.maxDurationMs = parseInt(maxDuration, 10) * 60_000; // minutes → ms
  const maxSessions = getFlag('--max-sessions');
  if (maxSessions) limits.maxConcurrentSessions = parseInt(maxSessions, 10);

  const store = new SessionStore(dataDir);
  const server = createServer(port, publicDir, store, {
    claudePath: claudePath || undefined,
    limits: Object.keys(limits).length > 0 ? limits : undefined,
  });

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

async function cmdNew(): Promise<void> {
  const prompt = getFlag('-p') || getFlag('--prompt');
  if (!prompt) {
    process.stderr.write('probe new: -p "prompt" required\n');
    process.exit(1);
  }

  const body: Record<string, unknown> = { prompt };
  const model = getFlag('--model');
  if (model) body.model = model;
  if (hasFlag('--auto-approve')) body.autoApprove = true;
  const cwd = getFlag('--cwd');
  if (cwd) body.cwd = path.resolve(cwd);
  const resume = getFlag('-r') || getFlag('--resume');
  if (resume) body.resumeSessionId = resume;
  const flags: string[] = [];
  const permMode = getFlag('--permission-mode');
  if (permMode) flags.push('--permission-mode', permMode);
  const allowedTools = getFlag('--allowedTools') || getFlag('--allowed-tools');
  if (allowedTools) flags.push('--allowedTools', allowedTools);
  if (hasFlag('--dangerously-skip-permissions')) flags.push('--dangerously-skip-permissions');
  if (flags.length) body.flags = flags;
  // Per-session limits
  const sessionLimits: Record<string, number> = {};
  const sCost = getFlag('--max-cost');
  if (sCost) sessionLimits.maxCostUsd = parseFloat(sCost);
  const sTurns = getFlag('--max-turns');
  if (sTurns) sessionLimits.maxTurns = parseInt(sTurns, 10);
  if (Object.keys(sessionLimits).length > 0) body.limits = sessionLimits;

  const res = await httpPost('/api/sessions', body);
  if (res.status !== 200) {
    process.stderr.write(`probe new: ${asRecord(res.data).error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write(`${asRecord(res.data).sessionId}\n`);
}

async function cmdStatus(): Promise<void> {
  const id = args[1];
  if (!id) { process.stderr.write('probe status: session ID required\n'); process.exit(1); }

  const res = await httpGet(`/api/sessions/${id}/status`);
  if (res.status !== 200) {
    process.stderr.write(`probe status: ${asRecord(res.data).error || 'not found'}\n`);
    process.exit(1);
  }

  const s = asRecord(res.data);
  let line = `status: ${s.status}`;
  if (s.phase && s.phase !== s.status) line += ` (${s.phase})`;
  if (s.model) line += ` | model: ${s.model}`;
  if (s.toolCalls) line += ` | tools: ${s.toolCalls}`;
  if (s.costUsd) line += ` | cost: ${formatCost(s.costUsd as number)}`;
  if (s.eventCount) line += ` | events: ${s.eventCount}`;
  process.stdout.write(line + '\n');

  if (s.stuckForMs && (s.stuckForMs as number) > 30000) {
    process.stdout.write(`warning: no activity for ${formatDuration(s.stuckForMs as number)}\n`);
  }

  if (s.pendingApproval) {
    const a = s.pendingApproval as Record<string, unknown>;
    let detail = `awaiting: ${a.toolName}`;
    if (a.requestedAt) {
      detail += ` (waiting ${formatDuration(Date.now() - (a.requestedAt as number))})`;
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

async function cmdEvents(): Promise<void> {
  const id = args[1];
  if (!id) { process.stderr.write('probe events: session ID required\n'); process.exit(1); }

  const last = getFlag('--last') || '20';
  const res = await httpGet(`/api/sessions/${id}/events?last=${last}`);
  if (res.status !== 200) {
    process.stderr.write(`probe events: ${asRecord(res.data).error || 'not found'}\n`);
    process.exit(1);
  }

  const events = (asRecord(res.data).events || []) as Record<string, unknown>[];
  for (const e of events) {
    const time = new Date(e.ts as number).toLocaleTimeString('en-US', { hour12: false });
    let line = `[${time}] `;

    switch (e.kind) {
      case 'init':
        line += `init model=${e.model}`;
        break;
      case 'text':
        line += `text: ${truncate(e.text as string, 120)}`;
        break;
      case 'text_delta':
        continue;
      case 'tool_call':
        line += `tool: ${e.toolName} ${truncate(typeof e.input === 'string' ? e.input : JSON.stringify(e.input), 100)}`;
        break;
      case 'tool_result':
        line += `result: ${truncate(e.content as string, 100)}${e.isError ? ' [ERROR]' : ''}`;
        break;
      case 'thinking':
        line += `thinking: ${truncate(e.text as string, 80)}`;
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
        line += `end: ${e.isError ? 'ERROR' : 'ok'} cost=${formatCost(e.costUsd as number)} turns=${e.numTurns}`;
        break;
      case 'session_complete':
        line += `complete (${formatDuration(e.durationMs as number)})`;
        break;
      case 'session_resumed':
        line += `resumed`;
        break;
      case 'block_start':
        if (e.blockType === 'tool_use') {
          line += `tool_start: ${e.toolName}`;
        } else {
          continue;
        }
        break;
      default:
        continue;
    }

    process.stdout.write(line + '\n');
  }
}

async function cmdSend(): Promise<void> {
  const id = args[1];
  if (!id) { process.stderr.write('probe send: session ID required\n'); process.exit(1); }

  const prompt = getFlag('-p') || getFlag('--prompt');
  if (!prompt) { process.stderr.write('probe send: -p "prompt" required\n'); process.exit(1); }

  const res = await httpPost(`/api/sessions/${id}/message`, { prompt });
  if (res.status !== 200) {
    process.stderr.write(`probe send: ${asRecord(res.data).error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write(`sent (${asRecord(res.data).status})\n`);
}

async function cmdApprove(): Promise<void> {
  const id = args[1];
  if (!id) { process.stderr.write('probe approve: session ID required\n'); process.exit(1); }

  const res = await httpPost(`/api/sessions/${id}/approve`, {});
  if (res.status !== 200) {
    process.stderr.write(`probe approve: ${asRecord(res.data).error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write('approved\n');
}

async function cmdDeny(): Promise<void> {
  const id = args[1];
  if (!id) { process.stderr.write('probe deny: session ID required\n'); process.exit(1); }

  const message = getFlag('-m') || getFlag('--message') || '';
  const res = await httpPost(`/api/sessions/${id}/deny`, { message });
  if (res.status !== 200) {
    process.stderr.write(`probe deny: ${asRecord(res.data).error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write('denied\n');
}

async function cmdClose(): Promise<void> {
  const id = args[1];
  if (!id) { process.stderr.write('probe close: session ID required\n'); process.exit(1); }

  const res = await httpPost(`/api/sessions/${id}/close`, {});
  if (res.status !== 200) {
    process.stderr.write(`probe close: ${asRecord(res.data).error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write(`closed${asRecord(res.data).wasActive ? '' : ' (was already done)'}\n`);
}

async function cmdShutdown(): Promise<void> {
  const res = await httpPost('/api/shutdown', {});
  if (res.status !== 200) {
    process.stderr.write(`probe shutdown: ${asRecord(res.data).error || 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write('server stopped\n');
}

async function cmdResult(): Promise<void> {
  const id = args[1];
  if (!id) { process.stderr.write('probe result: session ID required\n'); process.exit(1); }

  const res = await httpGet(`/api/sessions/${id}/result`);
  if (res.status !== 200) {
    process.stderr.write(`probe result: ${asRecord(res.data).error || 'not found'}\n`);
    process.exit(1);
  }

  const d = asRecord(res.data);
  if (d.result) {
    process.stdout.write(d.result + '\n');
  } else if (d.status && d.status !== 'done') {
    process.stdout.write(`(session still ${d.status})\n`);
  } else {
    process.stdout.write('(no result)\n');
  }
}

async function cmdSessions(): Promise<void> {
  const res = await httpGet('/api/sessions');
  if (res.status !== 200) {
    process.stderr.write('probe sessions: failed to list\n');
    process.exit(1);
  }

  const sessions = (res.data || []) as Record<string, unknown>[];
  if (sessions.length === 0) {
    process.stdout.write('no sessions\n');
    return;
  }

  for (const s of sessions) {
    let line = `${s.id}`;
    if (s.status) line += ` [${s.status}]`;
    else if (s.ended) line += ' [done]';
    if (s.model) line += ` ${s.model}`;
    if (s.costUsd) line += ` ${formatCost(s.costUsd as number)}`;
    if (s.toolCalls) line += ` ${s.toolCalls}tools`;
    if (s.preview) line += ` "${truncate(s.preview as string, 60)}"`;
    process.stdout.write(line + '\n');
  }
}

async function cmdDoctor(): Promise<void> {
  let healthOk = false;
  try {
    const health = await httpGet('/api/health');
    const d = asRecord(health.data);
    healthOk = health.status === 200 && d.ok === true;
    process.stdout.write(`server: ${healthOk ? 'OK' : 'UNHEALTHY'} (port ${port})\n`);
    process.stdout.write(`  active sessions: ${d.activeSessions}\n`);
  } catch (err: unknown) {
    process.stdout.write(`server: UNREACHABLE (port ${port})\n`);
    process.stdout.write(`  ${(err as Error).message}\n`);
    process.exit(1);
  }

  try {
    const diag = await httpGet('/api/diagnostics');
    if (diag.status === 200) {
      const d = asRecord(diag.data);
      process.stdout.write(`  uptime: ${formatDuration((d.serverUptime as number) * 1000)}\n`);
      process.stdout.write(`  dashboard clients: ${d.dashboardClients}\n`);
      process.stdout.write(`  watchdog tracking: ${d.watchdogTracking}\n`);

      if (d.sessions && (d.sessions as unknown[]).length > 0) {
        process.stdout.write(`\nsessions:\n`);
        for (const s of d.sessions as Record<string, unknown>[]) {
          let line = `  ${s.sessionId} [${s.status}]`;
          line += ` proc=${s.processAlive ? 'alive' : 'dead'}`;
          line += ` ws=${s.wsConnected ? 'connected' : 'disconnected'}`;
          line += ` events=${s.eventCount}`;
          if (s.stuckForMs && (s.stuckForMs as number) > 10000) {
            line += ` stuck=${formatDuration(s.stuckForMs as number)}`;
          }
          if (s.error) line += ` error="${s.error}"`;
          process.stdout.write(line + '\n');
        }
      }
    }
  } catch {
    process.stdout.write('  (diagnostics endpoint not available)\n');
  }

  try {
    const { default: WebSocket } = await import('ws');
    await new Promise<void>((resolve, reject) => {
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
      testWs.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    process.stdout.write(`websocket: OK\n`);
  } catch (err: unknown) {
    process.stdout.write(`websocket: FAILED (${(err as Error).message})\n`);
  }
}

function printUsage(): void {
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
  --max-cost <usd>              Per-session cost cap (e.g. 0.50)
  --max-turns <n>               Per-session turn limit

Options for 'serve':
  --max-cost <usd>              Global default cost cap per session
  --max-turns <n>               Global default turn limit
  --max-duration <minutes>      Global default duration limit
  --max-sessions <n>            Max concurrent active sessions

Global:
  --port <port>                 Server port (default: 3456)

`);
}

// Suppress unused warnings for functions that are part of the public API
void httpDelete;

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
    if (!command || command.startsWith('-')) {
      cmdServe();
    } else {
      process.stderr.write(`probe: unknown command '${command}'\n`);
      printUsage();
      process.exit(1);
    }
}
