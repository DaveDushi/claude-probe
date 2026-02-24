import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { parseLine } from './parser';
import { SessionState, ProbeEvent, SessionSnapshot, Artifact, extractArtifacts } from './state';
import { SessionWatchdog } from './watchdog';
import { SessionStore } from './store';
import {
  SessionLimits, GlobalLimits, DEFAULT_GLOBAL_LIMITS, DEFAULT_SESSION_LIMITS,
  checkSessionLimits, checkConcurrency, CircuitBreaker,
} from './limits';
import { PolicyEngine } from './policies';

// ================================================================
// Types
// ================================================================

export type SessionStatus = 'starting' | 'running' | 'waiting_approval' | 'idle' | 'done' | 'error';

export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
  requestedAt: number;
}

export interface Session {
  sessionId: string;
  claudeSessionId: string | null;
  process: ChildProcess | null;
  ws: WebSocket | null;
  state: SessionState;
  status: SessionStatus;
  pendingApproval: PendingApproval | null;
  autoApprove: boolean;
  promptQueue: string[];
  gotResult: boolean;
  error: string | null;
  errorCode: string | null;
  lastActivityAt: number;
  prompt: string | null;
  model: string | undefined;
  cwd: string;
  limits: SessionLimits;
  parentSessionId: string | null;
  spawnReason: string | null;
  childSessionIds: string[];
  isReplay: boolean;
  replaySourceId: string | null;
  permissionMode: string;
}

interface CreateSessionOpts {
  prompt: string;
  model?: string;
  resumeSessionId?: string;
  autoApprove?: boolean;
  cwd?: string;
  passthroughFlags?: string[];
  limits?: Partial<SessionLimits>;
  parentSessionId?: string;
  spawnReason?: string;
}

interface IngestContext {
  sessionId: string | null;
  state: SessionState;
  /** True if a managed session already handles this Claude session — skip all writes. */
  isDuplicateOfManaged?: boolean;
}

export interface ServerOptions {
  claudePath?: string;
  limits?: Partial<GlobalLimits>;
  startupTimeoutMs?: number;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function findClaudeBinary(): string {
  const candidates: (string | undefined)[] = [
    process.env.CLAUDE_CLI_PATH,
    path.join(process.env.APPDATA || '', 'com.jean.desktop', 'claude-cli', 'claude.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', '@anthropic', 'claude-code', 'claude.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    path.join(process.env.APPDATA || '', 'npm', 'claude'),
    path.join(process.env.HOME || '', '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return 'claude';
}

export function createServer(port: number, publicDir: string, store: SessionStore, opts?: ServerOptions) {
  const claudeBinary = opts?.claudePath || findClaudeBinary();
  const globalLimits: GlobalLimits = { ...DEFAULT_GLOBAL_LIMITS, ...opts?.limits };

  // --- Dashboard WebSocket clients (browsers) ---
  const dashboardClients = new Set<WebSocket>();

  // --- Active sessions: sessionId → session object ---
  const activeSessions = new Map<string, Session>();

  // --- Circuit breaker for spawn failures ---
  const circuitBreaker = new CircuitBreaker();

  // --- Approval policy engine ---
  const policyEngine = new PolicyEngine();

  // --- Session watchdog (timeout detection) ---
  const watchdogOpts: Partial<import('./watchdog').WatchdogConfig> = {};
  if (opts?.startupTimeoutMs) watchdogOpts.startupTimeoutMs = opts.startupTimeoutMs;
  const watchdog = new SessionWatchdog(watchdogOpts);

  watchdog.onTimeout = (sessionId: string, reason: string, message: string) => {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    if (session.status === 'done' || session.status === 'error') return;

    session.status = 'error';
    session.error = message;
    session.errorCode = reason;

    const timeoutEvent: ProbeEvent = {
      id: `evt_${Date.now()}_timeout`,
      ts: Date.now(),
      kind: 'session_timeout',
      reason,
      message,
    };
    session.state.addEvent(timeoutEvent);
    store.appendEvent(session.sessionId, timeoutEvent);
    broadcastToDashboard(timeoutEvent, session.sessionId);
    broadcastSessionStatus(session);

    if (session.process) {
      try { session.process.kill(); } catch { /* ignore */ }
    }
    if (session.ws) {
      try { session.ws.close(); } catch { /* ignore */ }
    }
  };

  // --- Idle timeout: session auto-closes after no new prompts ---
  watchdog.onIdleExpired = (sessionId: string) => {
    const session = activeSessions.get(sessionId);
    if (!session || session.status !== 'idle') return;

    session.status = 'done';
    const idleEvent: ProbeEvent = {
      id: `evt_${Date.now()}_idle_done`,
      ts: Date.now(),
      kind: 'session_complete',
      reason: 'idle_timeout',
      durationMs: Date.now() - session.state.startTime,
    };
    session.state.addEvent(idleEvent);
    store.appendEvent(session.sessionId, idleEvent);
    broadcastToDashboard(idleEvent, session.sessionId);
    broadcastSessionStatus(session);

    if (session.process) {
      try { session.process.kill(); } catch { /* ignore */ }
    }
    if (session.ws) {
      try { session.ws.close(); } catch { /* ignore */ }
    }
  };

  // --- GC: remove done/error sessions from memory after delay ---
  const GC_INTERVAL_MS = 60_000;
  const GC_DELAY_MS = 60_000;
  const gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of activeSessions) {
      if (session.status !== 'done' && session.status !== 'error') continue;
      // Keep in memory for GC_DELAY_MS after terminal state
      const lastEvent = session.state.events[session.state.events.length - 1];
      if (lastEvent && now - lastEvent.ts > GC_DELAY_MS) {
        activeSessions.delete(id);
      }
    }
  }, GC_INTERVAL_MS);
  gcTimer.unref(); // don't keep process alive for GC

  // --- Legacy ingest support (pipe mode) ---
  const ingestSessions = new Map<string, IngestContext>();
  let activeConnectionId: string | null = null;
  const pendingPrompts = new Map<string, { prompt: string }>();
  /** First-claim-wins: maps Claude session ID → probe session ID to prevent duplicate files. */
  const claimedClaudeIds = new Map<string, string>();

  // ================================================================
  // Session management
  // ================================================================

  function createSession(opts: CreateSessionOpts): string {
    // --- Guard: circuit breaker ---
    if (circuitBreaker.isOpen()) {
      throw new Error('Circuit breaker open: too many recent spawn failures. Try again shortly.');
    }

    // --- Guard: concurrency limit ---
    const activeCount = [...activeSessions.values()].filter(s => s.status !== 'done' && s.status !== 'error').length;
    const concCheck = checkConcurrency(activeCount, globalLimits.maxConcurrentSessions);
    if (concCheck.exceeded) {
      throw new Error(concCheck.reason!);
    }

    const { prompt, model, resumeSessionId, autoApprove, cwd, passthroughFlags } = opts;
    const sessionId = store.generateSessionId();
    const sessionLimits: SessionLimits = {
      ...DEFAULT_SESSION_LIMITS,
      maxCostUsd: globalLimits.maxCostUsd,
      maxTurns: globalLimits.maxTurns,
      maxDurationMs: globalLimits.maxDurationMs,
      ...opts.limits,
    };

    const session: Session = {
      sessionId,
      claudeSessionId: null,
      process: null,
      ws: null,
      state: new SessionState(),
      status: 'starting',
      pendingApproval: null,
      autoApprove: autoApprove || false,
      promptQueue: [],
      gotResult: false,
      error: null,
      errorCode: null,
      lastActivityAt: Date.now(),
      prompt,
      model,
      cwd: cwd || process.cwd(),
      limits: sessionLimits,
      parentSessionId: opts.parentSessionId || null,
      spawnReason: opts.spawnReason || null,
      childSessionIds: [],
      isReplay: false,
      replaySourceId: null,
      permissionMode: 'plan', // default, overridden below
    };

    // Register as child on parent
    if (opts.parentSessionId) {
      const parent = activeSessions.get(opts.parentSessionId);
      if (parent) parent.childSessionIds.push(sessionId);
    }

    activeSessions.set(sessionId, session);
    watchdog.trackStarting(sessionId);

    const startEvent: ProbeEvent = {
      id: `evt_${Date.now()}_start`,
      ts: Date.now(),
      kind: 'session_start',
      cwd: session.cwd,
      prompt: prompt ? prompt.slice(0, 300) : '',
      model: model || null,
      autoApprove: session.autoApprove,
      parentSessionId: session.parentSessionId,
      spawnReason: session.spawnReason,
    };
    session.state.addEvent(startEvent);
    store.appendEvent(sessionId, startEvent);
    broadcastToDashboard(startEvent, sessionId);

    // Build Claude CLI args
    const wsUrl = `ws://localhost:${port}/ws?session=${sessionId}`;
    const claudeArgs: string[] = [
      '--sdk-url', wsUrl,
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--print',
      '-p', ' ', // placeholder — prompt sent via WS
    ];
    if (resumeSessionId) claudeArgs.push('--resume', resumeSessionId);
    if (model) claudeArgs.push('--model', model);

    const hasPermFlag = passthroughFlags &&
      (passthroughFlags.includes('--permission-mode') || passthroughFlags.includes('--dangerously-skip-permissions'));
    if (!hasPermFlag) {
      if (autoApprove) {
        claudeArgs.push('--permission-mode', 'bypassPermissions');
        session.permissionMode = 'bypassPermissions';
      } else {
        // Explicit plan mode ensures tool approvals route through the SDK
        // WebSocket as control_request messages (default mode uses terminal prompts)
        claudeArgs.push('--permission-mode', 'plan');
        session.permissionMode = 'plan';
      }
    } else if (passthroughFlags) {
      const pmIdx = passthroughFlags.indexOf('--permission-mode');
      if (pmIdx !== -1 && passthroughFlags[pmIdx + 1]) {
        session.permissionMode = passthroughFlags[pmIdx + 1];
      } else if (passthroughFlags.includes('--dangerously-skip-permissions')) {
        session.permissionMode = 'bypassPermissions';
      }
    }

    if (passthroughFlags) claudeArgs.push(...passthroughFlags);

    // Clean env to avoid nesting guard
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;

    const child = spawn(claudeBinary, claudeArgs, {
      env,
      cwd: session.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    session.process = child;

    // Capture stderr for debugging — store last chunk on session
    let stderrBuf = '';
    child.stderr!.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrBuf += text;
      // Keep only last 2KB to avoid memory bloat
      if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);
    });
    child.stdout!.on('data', () => {}); // drain stdout

    child.on('error', (err: Error) => {
      watchdog.untrack(session.sessionId);
      circuitBreaker.recordFailure();
      session.status = 'error';
      session.errorCode = 'spawn_error';
      session.error = `Failed to spawn claude: ${err.message}`;
      if (stderrBuf.trim()) session.error += `\nstderr: ${stderrBuf.trim().slice(-500)}`;
      broadcastSessionStatus(session);
    });

    child.on('exit', (code) => {
      watchdog.untrack(session.sessionId);
      if (session.status !== 'error') {
        if (code && code !== 0 && !session.ws) {
          // Exited with error before WS connected — likely connection failure
          session.status = 'error';
          session.errorCode = 'exit_before_connect';
          session.error = `Claude exited (code ${code}) before WebSocket connected`;
          if (stderrBuf.trim()) session.error += `\nstderr: ${stderrBuf.trim().slice(-500)}`;
        } else {
          session.status = 'done';
        }
      }
      broadcastSessionStatus(session);
    });

    return sessionId;
  }

  function getSession(sessionId: string): Session | null {
    return activeSessions.get(sessionId) || null;
  }

  function killSession(sessionId: string, tree?: boolean): boolean {
    const session = activeSessions.get(sessionId);
    if (!session) return false;

    // Recursively kill children first if tree mode
    if (tree) {
      for (const childId of [...session.childSessionIds]) {
        killSession(childId, true);
      }
    }

    // Remove from parent's child list
    if (session.parentSessionId) {
      const parent = activeSessions.get(session.parentSessionId);
      if (parent) {
        parent.childSessionIds = parent.childSessionIds.filter(id => id !== sessionId);
      }
    }

    if (session.process) {
      session.process.kill();
    }
    if (session.ws) {
      session.ws.close();
    }
    session.status = 'done';
    broadcastSessionStatus(session);
    watchdog.untrack(sessionId);
    policyEngine.clearSessionPolicies(sessionId);
    activeSessions.delete(sessionId);
    return true;
  }

  /** Check limits and kill session if exceeded. Returns true if session was killed. */
  function enforceLimits(session: Session): boolean {
    if (session.status === 'done' || session.status === 'error') return false;
    const check = checkSessionLimits(
      session.state.usage,
      session.state.turns,
      session.state.startTime,
      session.limits,
    );
    if (!check.exceeded) return false;

    session.status = 'error';
    session.error = check.reason;
    session.errorCode = check.code;

    const limitEvent: ProbeEvent = {
      id: `evt_${Date.now()}_limit`,
      ts: Date.now(),
      kind: 'limit_exceeded',
      reason: check.reason,
      code: check.code,
    };
    session.state.addEvent(limitEvent);
    store.appendEvent(session.sessionId, limitEvent);
    broadcastToDashboard(limitEvent, session.sessionId);
    broadcastSessionStatus(session);

    if (session.process) {
      try { session.process.kill(); } catch { /* ignore */ }
    }
    if (session.ws) {
      try { session.ws.close(); } catch { /* ignore */ }
    }
    watchdog.untrack(session.sessionId);
    return true;
  }

  function sendPromptToSession(session: Session, prompt: string): void {
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      session.promptQueue.push(prompt);
      return;
    }
    if (session.status === 'idle') {
      const userMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
        session_id: session.claudeSessionId || '',
      }) + '\n';
      session.ws.send(userMsg);
      emitUserMessage(session, prompt);
      session.status = 'running';
      session.gotResult = false;
      watchdog.trackRunning(session.sessionId);
      broadcastSessionStatus(session);
    } else {
      session.promptQueue.push(prompt);
    }
  }

  function emitUserMessage(session: Session, prompt: string): void {
    const event: ProbeEvent = {
      id: `evt_${Date.now()}_user`,
      ts: Date.now(),
      kind: 'user_message',
      text: prompt,
    };
    session.state.addEvent(event);
    store.appendEvent(session.sessionId, event);
    broadcastToDashboard(event, session.sessionId);
  }

  function approveSession(session: Session): boolean {
    if (!session.pendingApproval || !session.ws) return false;
    const response = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: session.pendingApproval.requestId,
        response: { behavior: 'allow' },
      },
    }) + '\n';
    session.ws.send(response);

    const grantedEvent: ProbeEvent = {
      id: `evt_${Date.now()}_approved`,
      ts: Date.now(),
      kind: 'approval_granted',
      toolName: session.pendingApproval.toolName,
      requestId: session.pendingApproval.requestId,
    };
    session.state.addEvent(grantedEvent);
    store.appendEvent(session.sessionId, grantedEvent);
    broadcastToDashboard(grantedEvent, session.sessionId);

    session.pendingApproval = null;
    session.status = 'running';
    watchdog.trackApprovalResolved(session.sessionId);
    broadcastSessionStatus(session);
    return true;
  }

  function denySession(session: Session, message: string): boolean {
    if (!session.pendingApproval || !session.ws) return false;
    const response = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: session.pendingApproval.requestId,
        response: {
          behavior: 'deny',
          message: message || 'Denied by user',
        },
      },
    }) + '\n';
    session.ws.send(response);

    const deniedEvent: ProbeEvent = {
      id: `evt_${Date.now()}_denied`,
      ts: Date.now(),
      kind: 'approval_denied',
      toolName: session.pendingApproval.toolName,
      requestId: session.pendingApproval.requestId,
      message: message || 'Denied by user',
    };
    session.state.addEvent(deniedEvent);
    store.appendEvent(session.sessionId, deniedEvent);
    broadcastToDashboard(deniedEvent, session.sessionId);

    session.pendingApproval = null;
    session.status = 'running';
    watchdog.trackApprovalResolved(session.sessionId);
    broadcastSessionStatus(session);
    return true;
  }

  // ================================================================
  // Event handling
  // ================================================================

  function getOrCreateIngest(connectionId: string): IngestContext {
    if (ingestSessions.has(connectionId)) return ingestSessions.get(connectionId)!;
    const ctx: IngestContext = { sessionId: null, state: new SessionState() };
    ingestSessions.set(connectionId, ctx);
    activeConnectionId = connectionId;
    return ctx;
  }

  function handleIngestEvents(connectionId: string, events: ProbeEvent[], session?: Session): void {
    const ctx = session
      ? { sessionId: session.sessionId, state: session.state }
      : getOrCreateIngest(connectionId);

    for (const event of events) {
      // Skip all events if this ingest is a duplicate of another connection
      if (ctx.isDuplicateOfManaged) continue;

      if (event.kind === 'init' && event.sessionId) {
        const claudeId = event.sessionId as string;

        // First-claim-wins: whoever processes init first owns this Claude session ID.
        // Any later connection with the same Claude ID is a duplicate.
        if (claimedClaudeIds.has(claudeId)) {
          ctx.isDuplicateOfManaged = true;
          continue;
        }

        if (session) {
          session.claudeSessionId = claudeId;
          claimedClaudeIds.set(claudeId, session.sessionId);
        } else {
          if (store.hasSession(claudeId)) {
            ctx.sessionId = claudeId;
            const existing = store.loadSession(ctx.sessionId);
            if (existing) {
              for (const e of existing) ctx.state.addEvent(e);
            }
            const resumeEvent: ProbeEvent = {
              id: `evt_${Date.now()}_resume`,
              ts: Date.now(),
              kind: 'session_resumed',
              sessionId: event.sessionId,
            };
            ctx.state.addEvent(resumeEvent);
            store.appendEvent(ctx.sessionId, resumeEvent);
            broadcastToDashboard(resumeEvent, ctx.sessionId);
          } else {
            ctx.sessionId = claudeId;
          }
          claimedClaudeIds.set(claudeId, ctx.sessionId || claudeId);
        }
      }

      if (!ctx.sessionId) {
        ctx.sessionId = store.generateSessionId();
        if (session) session.sessionId = ctx.sessionId;
      }

      ctx.state.addEvent(event);
      store.appendEvent(ctx.sessionId, event);
      broadcastToDashboard(event, ctx.sessionId);
    }
  }

  function closeIngest(connectionId: string): string | null {
    const ctx = ingestSessions.get(connectionId);
    if (!ctx) return null;

    // Don't write terminal event for duplicate ingests — managed session handles it
    if (!ctx.isDuplicateOfManaged) {
      const endEvent: ProbeEvent = {
        id: `evt_${Date.now()}_end`,
        ts: Date.now(),
        kind: 'session_complete',
        durationMs: Date.now() - ctx.state.startTime,
      };
      ctx.state.addEvent(endEvent);
      if (ctx.sessionId) {
        store.appendEvent(ctx.sessionId, endEvent);
      }
      broadcastToDashboard(endEvent, ctx.sessionId);
    }

    const sessionId = ctx.sessionId;
    ingestSessions.delete(connectionId);
    if (activeConnectionId === connectionId) {
      activeConnectionId = ingestSessions.size > 0
        ? [...ingestSessions.keys()].pop()!
        : null;
    }
    return sessionId;
  }

  // ================================================================
  // Broadcasting
  // ================================================================

  function getSnapshot(sessionId?: string): SessionSnapshot | null {
    if (sessionId) {
      const session = activeSessions.get(sessionId);
      if (session) return session.state.getSnapshot();
      return null;
    }
    for (const [, session] of [...activeSessions].reverse()) {
      if (session.status !== 'done') return session.state.getSnapshot();
    }
    if (activeConnectionId && ingestSessions.has(activeConnectionId)) {
      return ingestSessions.get(activeConnectionId)!.state.getSnapshot();
    }
    if (activeSessions.size > 0) {
      return [...activeSessions.values()].pop()!.state.getSnapshot();
    }
    return null;
  }

  function broadcastToDashboard(event: ProbeEvent, sessionId: string | null): void {
    const msg = JSON.stringify({ type: 'event', data: event, sessionId });
    for (const ws of dashboardClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  function broadcastSessionStatus(session: Session): void {
    const msg = JSON.stringify({
      type: 'session_status',
      sessionId: session.sessionId,
      status: session.status,
      pendingApproval: session.pendingApproval,
      parentSessionId: session.parentSessionId,
      childSessionIds: session.childSessionIds,
      permissionMode: session.permissionMode,
      error: session.error,
      errorCode: session.errorCode,
    });
    for (const ws of dashboardClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  // ================================================================
  // HTTP helpers
  // ================================================================

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }

  function json(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  function parseRoute(urlPath: string): { id: string; action: string | null } | null {
    const m = urlPath.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
    if (m) return { id: decodeURIComponent(m[1]), action: m[2] || null };
    return null;
  }

  // ================================================================
  // HTTP server
  // ================================================================

  const httpServer = http.createServer(async (req, res) => {
    const [urlPath] = req.url!.split('?');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Connection-Id');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // --- Health ---
    if (urlPath === '/api/health' && req.method === 'GET') {
      json(res, 200, { ok: true, activeSessions: activeSessions.size });
      return;
    }

    // --- Diagnostics ---
    if (urlPath === '/api/diagnostics' && req.method === 'GET') {
      const sessions = [];
      for (const [id, session] of activeSessions) {
        const processAlive = !!(session.process && !session.process.killed && session.process.exitCode === null);
        const wsConnected = !!(session.ws && session.ws.readyState === WebSocket.OPEN);
        sessions.push({
          sessionId: id,
          status: session.status,
          processAlive,
          wsConnected,
          eventCount: session.state.events.length,
          lastActivityAt: session.lastActivityAt || null,
          stuckForMs: session.lastActivityAt ? Date.now() - session.lastActivityAt : null,
          errorCode: session.errorCode || null,
          error: session.error || null,
        });
      }
      json(res, 200, {
        ok: true,
        serverUptime: process.uptime(),
        activeSessions: activeSessions.size,
        dashboardClients: dashboardClients.size,
        watchdogTracking: watchdog.timers.size,
        circuitBreaker: circuitBreaker.getStatus(),
        globalLimits,
        sessions,
      });
      return;
    }

    // --- Shutdown ---
    if (urlPath === '/api/shutdown' && req.method === 'POST') {
      for (const [id] of activeSessions) killSession(id);
      json(res, 200, { ok: true });
      wss.clients.forEach(c => c.close());
      wss.close(() => {
        httpServer.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000);
      });
      return;
    }

    // --- Create session ---
    if (urlPath === '/api/sessions' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.prompt) { json(res, 400, { error: 'prompt required' }); return; }
        const sessionId = createSession({
          prompt: body.prompt,
          model: body.model,
          resumeSessionId: body.resumeSessionId,
          autoApprove: body.autoApprove || false,
          cwd: body.cwd,
          passthroughFlags: body.flags,
          limits: body.limits,
          parentSessionId: body.parentSessionId,
          spawnReason: body.spawnReason,
        });
        json(res, 200, { sessionId });
      } catch (err: unknown) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // --- List sessions ---
    if (urlPath === '/api/sessions' && req.method === 'GET') {
      const stored = store.listSessions();
      for (const s of stored) {
        const active = [...activeSessions.values()].find(a => a.sessionId === s.id);
        if (active) {
          s.status = active.status;
          s.pendingApproval = active.pendingApproval;
          s.cwd = active.cwd;
        }
      }
      for (const [id, active] of activeSessions) {
        const existing = stored.find(s => s.id === id);
        if (existing) {
          // Enrich stored summary with live hierarchy + artifact data
          existing.parentSessionId = active.parentSessionId;
          existing.artifactCount = active.state.artifacts.length;
        } else {
          stored.unshift({
            id,
            claudeSessionId: active.claudeSessionId,
            model: active.model || active.state.model,
            startTime: active.state.startTime,
            costUsd: null,
            durationMs: null,
            numTurns: null,
            isError: false,
            toolCalls: 0,
            fileSize: 0,
            preview: null,
            status: active.status,
            pendingApproval: active.pendingApproval,
            eventCount: active.state.events.length,
            ended: active.status === 'done' || active.status === 'error',
            cwd: active.cwd,
            parentSessionId: active.parentSessionId,
            artifactCount: active.state.artifacts.length,
          });
        }
      }
      // Mark orphaned sessions as recoverable
      const activeIds = new Set(activeSessions.keys());
      for (const s of stored) {
        if (!s.ended && s.eventCount > 0 && !activeIds.has(s.id)) {
          s.recoverable = true;
        }
      }

      json(res, 200, stored);
      return;
    }

    // --- Session routes: /api/sessions/:id[/:action] ---
    const route = parseRoute(urlPath);
    if (route) {
      const { id, action } = route;

      if (!action && req.method === 'GET') {
        const events = store.loadSession(id);
        if (!events) { json(res, 404, { error: 'Session not found' }); return; }
        const session = activeSessions.get(id);
        json(res, 200, {
          id,
          events,
          status: session ? session.status : 'done',
          pendingApproval: session ? session.pendingApproval : null,
          cwd: session ? session.cwd : null,
          parentSessionId: session ? session.parentSessionId : null,
          childSessionIds: session ? session.childSessionIds : [],
        });
        return;
      }

      if (!action && req.method === 'DELETE') {
        killSession(id);
        const deleted = store.deleteSession(id);
        json(res, deleted ? 200 : 404, { deleted });
        return;
      }

      if (action === 'status' && req.method === 'GET') {
        const session = activeSessions.get(id);
        if (!session) {
          if (store.hasSession(id)) {
            json(res, 200, { sessionId: id, status: 'done' });
          } else {
            json(res, 404, { error: 'Session not found' });
          }
          return;
        }
        const s = session.state;
        const toolCalls = s.events.filter(e => e.kind === 'tool_call' || (e.kind === 'block_start' && e.blockType === 'tool_use')).length;
        const isTerminal = session.status === 'done' || session.status === 'error';
        const result: Record<string, unknown> = {
          sessionId: id,
          claudeSessionId: session.claudeSessionId,
          status: session.status,
          phase: session.status === 'starting' ? 'waiting_for_ws'
               : session.status === 'running' ? (s.events.length <= 2 ? 'initializing' : 'processing')
               : session.status === 'waiting_approval' ? 'awaiting_approval'
               : session.status,
          model: s.model,
          cwd: session.cwd,
          toolCalls,
          eventCount: s.events.length,
          costUsd: s.usage.costUsd,
          error: session.error,
          errorCode: session.errorCode || null,
          lastActivityAt: session.lastActivityAt || null,
          stuckForMs: (!isTerminal && session.lastActivityAt)
            ? Date.now() - session.lastActivityAt
            : null,
          startedAt: s.startTime,
          turns: session.state.turns,
          limits: session.limits,
          parentSessionId: session.parentSessionId,
          childSessionIds: session.childSessionIds,
          spawnReason: session.spawnReason,
          artifactCount: session.state.artifacts.length,
          permissionMode: session.permissionMode,
          autoApprove: session.autoApprove,
        };
        if (session.pendingApproval) {
          result.pendingApproval = session.pendingApproval;
        }
        json(res, 200, result);
        return;
      }

      if (action === 'events' && req.method === 'GET') {
        const session = activeSessions.get(id);
        const reqUrl = new URL(req.url!, `http://localhost:${port}`);
        const last = parseInt(reqUrl.searchParams.get('last') || '0') || 0;
        const since = reqUrl.searchParams.get('since');

        let events: ProbeEvent[];
        if (session) {
          events = session.state.events;
        } else {
          const loaded = store.loadSession(id);
          if (!loaded) { json(res, 404, { error: 'Session not found' }); return; }
          events = loaded;
        }

        if (since) {
          const idx = events.findIndex(e => e.id === since);
          if (idx !== -1) events = events.slice(idx + 1);
        }

        if (last > 0) events = events.slice(-last);

        json(res, 200, { sessionId: id, events });
        return;
      }

      if (action === 'result' && req.method === 'GET') {
        const session = activeSessions.get(id);
        let events: ProbeEvent[];
        if (session) {
          events = session.state.events;
        } else {
          const loaded = store.loadSession(id);
          if (!loaded) { json(res, 404, { error: 'Session not found' }); return; }
          events = loaded;
        }
        const endEvent = [...events].reverse().find(e => e.kind === 'session_end');
        if (endEvent) {
          json(res, 200, { sessionId: id, result: endEvent.result, costUsd: endEvent.costUsd, isError: endEvent.isError });
        } else {
          const texts = events.filter(e => e.kind === 'text').map(e => e.text);
          json(res, 200, { sessionId: id, result: (texts.join('') as string) || null, status: session ? session.status : 'done' });
        }
        return;
      }

      if (action === 'artifacts' && req.method === 'GET') {
        const session = activeSessions.get(id);
        let artifacts: Artifact[];
        if (session) {
          artifacts = session.state.artifacts;
        } else {
          const events = store.loadSession(id);
          if (!events) { json(res, 404, { error: 'Session not found' }); return; }
          // Recompute artifacts from stored events
          artifacts = [];
          for (const evt of events) {
            if (evt.kind === 'tool_call') {
              artifacts.push(...extractArtifacts(
                evt.toolName as string, evt.toolId as string, evt.input, evt.ts,
              ));
            }
          }
        }
        json(res, 200, { sessionId: id, artifacts });
        return;
      }

      if (action === 'recover' && req.method === 'POST') {
        // Recover an orphaned session by resuming its Claude conversation
        const active = activeSessions.get(id);
        if (active && active.status !== 'done' && active.status !== 'error') {
          json(res, 409, { error: 'Session is still active' }); return;
        }
        if (!store.hasSession(id)) { json(res, 404, { error: 'Session not found' }); return; }
        const events = store.loadSession(id);
        if (!events || events.length === 0) { json(res, 400, { error: 'Session has no events' }); return; }

        // Check if already ended
        const hasTerminal = events.some(e =>
          e.kind === 'session_end' || e.kind === 'session_complete'
        );
        if (hasTerminal) { json(res, 400, { error: 'Session already ended' }); return; }

        // Extract Claude session ID for resume
        const claudeId = store.getClaudeSessionId(id);
        if (!claudeId) { json(res, 400, { error: 'No Claude session ID found (crashed before init)' }); return; }

        // Extract original model and cwd from events
        let origModel: string | undefined;
        let origCwd: string | undefined;
        for (const evt of events) {
          if (evt.kind === 'session_start') {
            if (evt.cwd) origCwd = evt.cwd as string;
            if (evt.model) origModel = evt.model as string;
          }
          if (evt.kind === 'init' && evt.model) origModel = evt.model as string;
        }

        // Mark old session as recovered (append terminal event)
        const recoveredEvent: ProbeEvent = {
          id: `evt_${Date.now()}_recovered`,
          ts: Date.now(),
          kind: 'session_complete',
          reason: 'recovered',
          durationMs: Date.now() - (events[0]?.ts || Date.now()),
        };
        store.appendEvent(id, recoveredEvent);

        // Parse body for optional overrides
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(await readBody(req)); } catch { /* use defaults */ }

        // Create new session that resumes the Claude conversation
        const newSessionId = createSession({
          prompt: (body.prompt as string) || 'Continue from where you left off.',
          model: (body.model as string) || origModel,
          resumeSessionId: claudeId,
          cwd: origCwd,
          parentSessionId: id, // link recovery chain
          spawnReason: 'recovered',
        });

        json(res, 200, { newSessionId, claudeSessionId: claudeId, recoveredFrom: id });
        return;
      }

      if (action === 'replay' && req.method === 'POST') {
        // Create a replay session that feeds stored events through the dashboard
        if (!store.hasSession(id)) { json(res, 404, { error: 'Session not found' }); return; }
        const rawEvents = store.loadSession(id);
        if (!rawEvents || rawEvents.length === 0) { json(res, 400, { error: 'Session has no events' }); return; }
        const replayEvents = rawEvents; // non-null after guard

        let body: Record<string, unknown> = {};
        try { body = JSON.parse(await readBody(req)); } catch { /* use defaults */ }
        let speed = parseFloat(body.speed as string) || 10;
        if (speed < 0.1) speed = 0.1;

        const replayId = store.generateSessionId();

        // Create a session object without a child process
        const replaySession: Session = {
          sessionId: replayId,
          claudeSessionId: null,
          process: null,
          ws: null,
          state: new SessionState(),
          status: 'running',
          pendingApproval: null,
          autoApprove: true,
          promptQueue: [],
          gotResult: false,
          error: null,
          errorCode: null,
          lastActivityAt: Date.now(),
          prompt: null,
          model: undefined,
          cwd: process.cwd(),
          limits: { ...DEFAULT_SESSION_LIMITS },
          parentSessionId: null,
          spawnReason: 'replay',
          childSessionIds: [],
          isReplay: true,
          replaySourceId: id,
          permissionMode: 'bypassPermissions',
        };

        activeSessions.set(replayId, replaySession);

        // Emit replay start event
        const startEvent: ProbeEvent = {
          id: `evt_${Date.now()}_replay_start`,
          ts: Date.now(),
          kind: 'session_start',
          cwd: replaySession.cwd,
          prompt: `[Replay of ${id}]`,
          model: null,
          isReplay: true,
          replaySourceId: id,
        };
        replaySession.state.addEvent(startEvent);
        store.appendEvent(replayId, startEvent);
        broadcastToDashboard(startEvent, replayId);
        broadcastSessionStatus(replaySession);

        // Start async replay loop
        let idx = 0;
        function scheduleNext() {
          if (idx >= replayEvents.length || replaySession.status === 'done' || replaySession.status === 'error') {
            // End replay
            replaySession.status = 'done';
            const endEvent: ProbeEvent = {
              id: `evt_${Date.now()}_replay_end`,
              ts: Date.now(),
              kind: 'session_complete',
              reason: 'replay_finished',
              durationMs: Date.now() - replaySession.state.startTime,
            };
            replaySession.state.addEvent(endEvent);
            store.appendEvent(replayId, endEvent);
            broadcastToDashboard(endEvent, replayId);
            broadcastSessionStatus(replaySession);
            return;
          }

          const evt = replayEvents[idx];
          const nextEvt = replayEvents[idx + 1];
          idx++;

          // Re-ID and re-timestamp the event
          const replayedEvent: ProbeEvent = {
            ...evt,
            id: `evt_${Date.now()}_r${idx}`,
            ts: Date.now(),
          };
          replaySession.state.addEvent(replayedEvent);
          store.appendEvent(replayId, replayedEvent);
          broadcastToDashboard(replayedEvent, replayId);
          replaySession.lastActivityAt = Date.now();

          // Calculate delay to next event
          let delayMs = 50; // minimum delay
          if (nextEvt && evt.ts && nextEvt.ts) {
            delayMs = Math.max(50, (nextEvt.ts - evt.ts) / speed);
            if (delayMs > 2000) delayMs = 2000; // cap at 2s
          }

          setTimeout(scheduleNext, delayMs);
        }

        scheduleNext();

        json(res, 200, { replaySessionId: replayId, eventCount: replayEvents.length, speed });
        return;
      }

      if (action === 'message' && req.method === 'POST') {
        const session = activeSessions.get(id);
        if (!session) { json(res, 404, { error: 'Session not found or not active' }); return; }
        try {
          const body = JSON.parse(await readBody(req));
          if (!body.prompt) { json(res, 400, { error: 'prompt required' }); return; }
          sendPromptToSession(session, body.prompt);
          json(res, 200, { sent: true, status: session.status });
        } catch (err: unknown) {
          json(res, 400, { error: (err as Error).message });
        }
        return;
      }

      if (action === 'approve' && req.method === 'POST') {
        const session = activeSessions.get(id);
        if (!session) { json(res, 404, { error: 'Session not found or not active' }); return; }
        if (!session.pendingApproval) { json(res, 400, { error: 'No pending approval' }); return; }
        approveSession(session);
        json(res, 200, { approved: true });
        return;
      }

      if (action === 'close' && req.method === 'POST') {
        let tree = false;
        try { tree = JSON.parse(await readBody(req)).tree === true; } catch { /* ignore */ }
        const killed = killSession(id, tree);
        if (!killed) {
          if (store.hasSession(id)) {
            json(res, 200, { closed: true, wasActive: false });
          } else {
            json(res, 404, { error: 'Session not found' });
          }
          return;
        }
        json(res, 200, { closed: true, wasActive: true, tree });
        return;
      }

      if (action === 'deny' && req.method === 'POST') {
        const session = activeSessions.get(id);
        if (!session) { json(res, 404, { error: 'Session not found or not active' }); return; }
        if (!session.pendingApproval) { json(res, 400, { error: 'No pending approval' }); return; }
        let message = '';
        try { message = JSON.parse(await readBody(req)).message || ''; } catch { /* ignore */ }
        denySession(session, message);
        json(res, 200, { denied: true });
        return;
      }
    }

    // --- Policy management ---
    if (urlPath === '/api/policies' && req.method === 'GET') {
      const sessionId = new URL(req.url!, `http://localhost:${port}`).searchParams.get('session') || undefined;
      json(res, 200, policyEngine.listActive(sessionId));
      return;
    }

    if (urlPath === '/api/policies' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.toolPattern) { json(res, 400, { error: 'toolPattern required' }); return; }
        const policy = policyEngine.addPolicy({
          toolPattern: body.toolPattern,
          pathPattern: body.pathPattern,
          scope: body.scope || 'global',
          sessionId: body.sessionId,
          expiresAt: body.expiresInMs ? Date.now() + body.expiresInMs : undefined,
        });
        json(res, 200, policy);
      } catch (err: unknown) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }

    if (urlPath?.startsWith('/api/policies/') && req.method === 'DELETE') {
      const policyId = urlPath.slice('/api/policies/'.length);
      const removed = policyEngine.removePolicy(decodeURIComponent(policyId));
      json(res, removed ? 200 : 404, { removed });
      return;
    }

    // --- Legacy: queue-prompt ---
    if (urlPath === '/api/queue-prompt' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const token = `tok_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        pendingPrompts.set(token, { prompt: body.prompt || '' });
        json(res, 200, { token });
      } catch (err: unknown) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }

    // --- Legacy: ingest API (pipe mode) ---
    if (urlPath === '/api/ingest' && req.method === 'POST') {
      const connectionId = req.headers['x-connection-id'] as string;
      if (!connectionId) { json(res, 400, { error: 'Missing X-Connection-Id header' }); return; }
      try {
        const body = await readBody(req);
        const events = parseLine(body.trim());
        handleIngestEvents(connectionId, events);
        json(res, 200, { ok: true });
      } catch (err: unknown) {
        json(res, 500, { error: (err as Error).message });
      }
      return;
    }

    if (urlPath === '/api/ingest/close' && req.method === 'POST') {
      const connectionId = req.headers['x-connection-id'] as string;
      if (!connectionId) { json(res, 400, { error: 'Missing X-Connection-Id header' }); return; }
      const sessionId = closeIngest(connectionId);
      json(res, 200, { closed: true, sessionId });
      return;
    }

    // --- Static files ---
    let filePath = urlPath === '/' ? '/index.html' : urlPath;
    filePath = path.join(publicDir, filePath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const normalizedPublic = path.resolve(publicDir);
    const normalizedFile = path.resolve(filePath);
    if (!normalizedFile.startsWith(normalizedPublic)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });

  // ================================================================
  // WebSocket server
  // ================================================================

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);

    if (reqUrl.pathname === '/ws') {
      handleClaudeWs(ws, reqUrl);
      return;
    }

    // Dashboard browser client
    dashboardClients.add(ws);
    const snap = getSnapshot();
    if (snap) {
      ws.send(JSON.stringify({ type: 'snapshot', data: snap }));
    }
    ws.on('close', () => dashboardClients.delete(ws));
    ws.on('error', () => dashboardClients.delete(ws));
  });

  // ================================================================
  // Claude CLI WebSocket handler
  // ================================================================

  function handleClaudeWs(ws: WebSocket, reqUrl: URL): void {
    const sessionId = reqUrl.searchParams.get('session');
    const token = reqUrl.searchParams.get('token');

    let session = sessionId ? activeSessions.get(sessionId) || null : null;
    const legacyPromptData = token ? pendingPrompts.get(token) : null;
    if (token) pendingPrompts.delete(token);

    const connectionId = `sdk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (session) {
      session.ws = ws;

      if (session.prompt) {
        const promptText = session.prompt;
        const userMsg = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: promptText },
          parent_tool_use_id: null,
          session_id: session.claudeSessionId || '',
        }) + '\n';
        ws.send(userMsg);
        session.prompt = null;
        session.status = 'running';
        session.gotResult = false;
        watchdog.trackRunning(session.sessionId);
        broadcastSessionStatus(session);
        emitUserMessage(session, promptText);
      }
    } else if (legacyPromptData && legacyPromptData.prompt) {
      const userMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: legacyPromptData.prompt },
        parent_tool_use_id: null,
        session_id: '',
      }) + '\n';
      ws.send(userMsg);
    }

    ws.on('message', (data: Buffer | string) => {
      const raw = data.toString();
      const lines = raw.split('\n').filter(l => l.trim());

      for (const line of lines) {
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(line); } catch { continue; }

        // --- Handle control_request (permission) ---
        if (obj.type === 'control_request') {
          const request = obj.request as Record<string, unknown> | undefined;

          // Safe fallback: malformed control_request → error response
          if (!request || !request.subtype || !obj.request_id) {
            const errorResponse = JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'error',
                request_id: obj.request_id || 'unknown',
                error: 'Malformed control_request: missing request or request_id',
              },
            }) + '\n';
            ws.send(errorResponse);
            continue;
          }

          if (request.subtype === 'can_use_tool') {
            const toolName = (request.tool_name as string) || 'unknown';
            // Protocol uses request.input (not tool_input)
            const toolInput = request.input ?? {};
            const requestId = obj.request_id as string;

            if (session && !session.autoApprove) {
              // Check approval policies first
              const policyMatch = policyEngine.match(toolName, toolInput, session.sessionId);

              if (policyMatch.matched) {
                // Policy auto-approves this tool use
                const response = JSON.stringify({
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: requestId,
                    response: { behavior: 'allow' },
                  },
                }) + '\n';
                ws.send(response);

                const policyEvent: ProbeEvent = {
                  id: `evt_${Date.now()}_policy_approve`,
                  ts: Date.now(),
                  kind: 'approval_granted',
                  toolName,
                  requestId,
                  autoPolicy: true,
                  policyId: policyMatch.policy!.id,
                };
                session.state.addEvent(policyEvent);
                store.appendEvent(session.sessionId, policyEvent);
                broadcastToDashboard(policyEvent, session.sessionId);
              } else {
                // Queue for manual approval
                session.pendingApproval = {
                  requestId,
                  toolName,
                  input: toolInput,
                  requestedAt: Date.now(),
                };
                session.status = 'waiting_approval';
                watchdog.trackApprovalWaiting(session.sessionId);
                broadcastSessionStatus(session);

                const approvalEvent: ProbeEvent = {
                  id: `evt_${Date.now()}_approval`,
                  ts: Date.now(),
                  kind: 'approval_request',
                  toolName,
                  input: toolInput,
                  requestId,
                };
                session.state.addEvent(approvalEvent);
                store.appendEvent(session.sessionId, approvalEvent);
                broadcastToDashboard(approvalEvent, session.sessionId);
              }
            } else {
              // Auto-approve (session-level flag)
              const response = JSON.stringify({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: requestId,
                  response: { behavior: 'allow' },
                },
              }) + '\n';
              ws.send(response);
            }
            continue;
          }

          // Unknown control_request subtype → error response
          const fallbackResponse = JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: obj.request_id as string,
              error: `Unknown control_request subtype: ${request.subtype}`,
            },
          }) + '\n';
          ws.send(fallbackResponse);
          continue;
        }

        // --- Ignore keep_alive ---
        if (obj.type === 'keep_alive') continue;

        // --- Parse and ingest ---
        const events = parseLine(line);
        handleIngestEvents(connectionId, events, session || undefined);

        // --- Watchdog: track activity ---
        if (session && events.length > 0) {
          session.lastActivityAt = Date.now();
          watchdog.trackActivity(session.sessionId);
          // Circuit breaker: first real event = successful start
          circuitBreaker.recordSuccess();
          // Enforce limits after each batch of events
          if (enforceLimits(session)) continue;
        }

        // --- Track session state ---
        if (session) {
          if (obj.type === 'system' && (obj as Record<string, unknown>).subtype === 'init') {
            session.claudeSessionId = obj.session_id as string;

            if (session.status === 'idle' && session.promptQueue.length > 0) {
              const nextPrompt = session.promptQueue.shift()!;
              sendPromptToSession(session, nextPrompt);
            }
          }

          if (obj.type === 'result') {
            session.state.turns++;
            session.status = 'idle';
            watchdog.trackIdle(session.sessionId);
            broadcastSessionStatus(session);

            // Check limits after turn completes
            if (!enforceLimits(session) && session.promptQueue.length > 0) {
              setTimeout(() => {
                if (session!.status === 'idle' && session!.promptQueue.length > 0) {
                  const nextPrompt = session!.promptQueue.shift()!;
                  sendPromptToSession(session!, nextPrompt);
                }
              }, 500);
            }
          }
        }
      }
    });

    ws.on('close', () => {
      if (session) {
        session.ws = null;
        watchdog.untrack(session.sessionId);
        if (session.status !== 'error') {
          session.status = 'done';
        }
        const endEvent: ProbeEvent = {
          id: `evt_${Date.now()}_end`,
          ts: Date.now(),
          kind: 'session_complete',
          durationMs: Date.now() - session.state.startTime,
        };
        session.state.addEvent(endEvent);
        store.appendEvent(session.sessionId, endEvent);
        broadcastToDashboard(endEvent, session.sessionId);
        broadcastSessionStatus(session);
      } else {
        closeIngest(connectionId);
      }
    });

    ws.on('error', () => {});
  }

  // ================================================================

  function start(): Promise<void> {
    return new Promise((resolve) => {
      httpServer.listen(port, '0.0.0.0', () => resolve());
    });
  }

  // Suppress unused variable warnings — getSession is part of the public API
  void getSession;

  return { start, broadcastToDashboard, getSnapshot, httpServer, watchdog };
}
