import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { parseLine } from './parser';
import { SessionState, ProbeEvent, SessionSnapshot } from './state';
import { SessionWatchdog } from './watchdog';
import { SessionStore } from './store';

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
}

interface CreateSessionOpts {
  prompt: string;
  model?: string;
  resumeSessionId?: string;
  autoApprove?: boolean;
  cwd?: string;
  passthroughFlags?: string[];
}

interface IngestContext {
  sessionId: string | null;
  state: SessionState;
}

export interface ServerOptions {
  claudePath?: string;
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

  // --- Dashboard WebSocket clients (browsers) ---
  const dashboardClients = new Set<WebSocket>();

  // --- Active sessions: sessionId → session object ---
  const activeSessions = new Map<string, Session>();

  // --- Session watchdog (timeout detection) ---
  const watchdog = new SessionWatchdog();

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

  // --- Legacy ingest support (pipe mode) ---
  const ingestSessions = new Map<string, IngestContext>();
  let activeConnectionId: string | null = null;
  const pendingPrompts = new Map<string, { prompt: string }>();

  // ================================================================
  // Session management
  // ================================================================

  function createSession(opts: CreateSessionOpts): string {
    const { prompt, model, resumeSessionId, autoApprove, cwd, passthroughFlags } = opts;
    const sessionId = store.generateSessionId();

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
    };

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
    if (autoApprove && !hasPermFlag) {
      claudeArgs.push('--permission-mode', 'bypassPermissions');
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

    child.stderr!.on('data', () => {}); // drain stderr
    child.stdout!.on('data', () => {}); // drain stdout

    child.on('error', (err: Error) => {
      watchdog.untrack(session.sessionId);
      session.status = 'error';
      session.errorCode = 'spawn_error';
      session.error = `Failed to spawn claude: ${err.message}`;
      broadcastSessionStatus(session);
    });

    child.on('exit', () => {
      watchdog.untrack(session.sessionId);
      if (session.status !== 'error') {
        session.status = 'done';
      }
      broadcastSessionStatus(session);
    });

    return sessionId;
  }

  function getSession(sessionId: string): Session | null {
    return activeSessions.get(sessionId) || null;
  }

  function killSession(sessionId: string): boolean {
    const session = activeSessions.get(sessionId);
    if (!session) return false;
    if (session.process) {
      session.process.kill();
    }
    if (session.ws) {
      session.ws.close();
    }
    session.status = 'done';
    broadcastSessionStatus(session);
    watchdog.untrack(sessionId);
    activeSessions.delete(sessionId);
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
      request_id: session.pendingApproval.requestId,
      response: {
        behavior: 'allow',
        updatedInput: session.pendingApproval.input,
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
      request_id: session.pendingApproval.requestId,
      response: {
        behavior: 'deny',
        message: message || 'Denied by user',
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
      if (event.kind === 'init' && event.sessionId) {
        if (!session) {
          if (store.hasSession(event.sessionId as string)) {
            ctx.sessionId = event.sessionId as string;
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
            ctx.sessionId = event.sessionId as string;
          }
        }
        if (session) {
          session.claudeSessionId = event.sessionId as string;
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
        if (!stored.find(s => s.id === id)) {
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
          });
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
        const killed = killSession(id);
        if (!killed) {
          if (store.hasSession(id)) {
            json(res, 200, { closed: true, wasActive: false });
          } else {
            json(res, 404, { error: 'Session not found' });
          }
          return;
        }
        json(res, 200, { closed: true, wasActive: true });
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
          if (request && request.subtype === 'can_use_tool') {
            if (session && !session.autoApprove) {
              session.pendingApproval = {
                requestId: obj.request_id as string,
                toolName: request.tool_name as string,
                input: request.tool_input,
                requestedAt: Date.now(),
              };
              session.status = 'waiting_approval';
              watchdog.trackApprovalWaiting(session.sessionId);
              broadcastSessionStatus(session);

              const approvalEvent: ProbeEvent = {
                id: `evt_${Date.now()}_approval`,
                ts: Date.now(),
                kind: 'approval_request',
                toolName: request.tool_name as string,
                input: request.tool_input,
                requestId: obj.request_id as string,
              };
              if (session) {
                session.state.addEvent(approvalEvent);
                store.appendEvent(session.sessionId, approvalEvent);
                broadcastToDashboard(approvalEvent, session.sessionId);
              }
            } else {
              const response = JSON.stringify({
                type: 'control_response',
                request_id: obj.request_id,
                response: {
                  behavior: 'allow',
                  updatedInput: request.tool_input,
                },
              }) + '\n';
              ws.send(response);
            }
            continue;
          }
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
            session.status = 'idle';
            broadcastSessionStatus(session);

            if (session.promptQueue.length > 0) {
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
