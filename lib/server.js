const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
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

function findClaudeBinary() {
  const fs2 = require('node:fs');
  const candidates = [
    // Common install locations
    process.env.CLAUDE_CLI_PATH,
    path.join(process.env.APPDATA || '', 'com.jean.desktop', 'claude-cli', 'claude.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', '@anthropic', 'claude-code', 'claude.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
    path.join(process.env.APPDATA || '', 'npm', 'claude'),
    // Unix paths
    path.join(process.env.HOME || '', '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];
  for (const p of candidates) {
    if (p && fs2.existsSync(p)) return p;
  }
  // Fallback: hope it's on PATH
  return 'claude';
}

function createServer(port, publicDir, store, opts) {
  const claudeBinary = (opts && opts.claudePath) || findClaudeBinary();
  // --- Dashboard WebSocket clients (browsers) ---
  const dashboardClients = new Set();

  // --- Active sessions: sessionId → session object ---
  const activeSessions = new Map();

  // --- Legacy ingest support (pipe mode) ---
  const ingestSessions = new Map();
  let activeConnectionId = null;
  const pendingPrompts = new Map(); // legacy token → { prompt }

  // ================================================================
  // Session management
  // ================================================================

  function createSession(opts) {
    const { prompt, model, resumeSessionId, autoApprove, cwd, passthroughFlags } = opts;
    const sessionId = store.generateSessionId();

    const session = {
      sessionId,
      claudeSessionId: null,
      process: null,
      ws: null,
      state: new SessionState(),
      status: 'starting',    // starting | running | waiting_approval | idle | done | error
      pendingApproval: null,  // { requestId, toolName, input }
      autoApprove: autoApprove || false,
      promptQueue: [],        // queued follow-up prompts
      gotResult: false,       // set after result, cleared on new prompt
      error: null,
      prompt,                 // initial prompt (consumed on first connect)
      model,
      cwd: cwd || process.cwd(),
    };

    activeSessions.set(sessionId, session);

    // Emit session_start event with metadata
    const startEvent = {
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
    const claudeArgs = [
      '--sdk-url', wsUrl,
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--print',
      '-p', ' ', // placeholder — prompt sent via WS
    ];
    if (resumeSessionId) claudeArgs.push('--resume', resumeSessionId);
    if (model) claudeArgs.push('--model', model);
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

    child.stderr.on('data', () => {}); // drain stderr
    child.stdout.on('data', () => {}); // drain stdout

    child.on('error', (err) => {
      session.status = 'error';
      session.error = `Failed to spawn claude: ${err.message}`;
      broadcastSessionStatus(session);
    });

    child.on('exit', (code) => {
      if (session.status !== 'error') {
        session.status = 'done';
      }
      broadcastSessionStatus(session);
    });

    return sessionId;
  }

  function getSession(sessionId) {
    return activeSessions.get(sessionId) || null;
  }

  function killSession(sessionId) {
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
    activeSessions.delete(sessionId);
    return true;
  }

  function sendPromptToSession(session, prompt) {
    if (!session.ws || session.ws.readyState !== 1) {
      session.promptQueue.push(prompt);
      return;
    }
    // Only send if CLI is idle (ready for next turn)
    if (session.status === 'idle') {
      const userMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
        session_id: session.claudeSessionId || '',
      }) + '\n';
      session.ws.send(userMsg);
      session.status = 'running';
      session.gotResult = false;
      broadcastSessionStatus(session);
    } else {
      session.promptQueue.push(prompt);
    }
  }

  function approveSession(session) {
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
    session.pendingApproval = null;
    session.status = 'running';
    broadcastSessionStatus(session);
    return true;
  }

  function denySession(session, message) {
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
    session.pendingApproval = null;
    session.status = 'running';
    broadcastSessionStatus(session);
    return true;
  }

  // ================================================================
  // Event handling
  // ================================================================

  function getOrCreateIngest(connectionId) {
    if (ingestSessions.has(connectionId)) return ingestSessions.get(connectionId);
    const ctx = { sessionId: null, state: new SessionState() };
    ingestSessions.set(connectionId, ctx);
    activeConnectionId = connectionId;
    return ctx;
  }

  function handleIngestEvents(connectionId, events, session) {
    // Use session if provided (new mode), else legacy ingest
    const ctx = session
      ? { sessionId: session.sessionId, state: session.state }
      : getOrCreateIngest(connectionId);

    for (const event of events) {
      if (event.kind === 'init' && event.sessionId) {
        if (!session) {
          // Legacy mode: handle resume
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
            broadcastToDashboard(resumeEvent, ctx.sessionId);
          } else {
            ctx.sessionId = event.sessionId;
          }
        }
        if (session) {
          session.claudeSessionId = event.sessionId;
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
    broadcastToDashboard(endEvent, ctx.sessionId);

    const sessionId = ctx.sessionId;
    ingestSessions.delete(connectionId);
    if (activeConnectionId === connectionId) {
      activeConnectionId = ingestSessions.size > 0
        ? [...ingestSessions.keys()].pop()
        : null;
    }
    return sessionId;
  }

  // ================================================================
  // Broadcasting
  // ================================================================

  function getSnapshot(sessionId) {
    // If specific session requested
    if (sessionId) {
      const session = activeSessions.get(sessionId);
      if (session) return session.state.getSnapshot();
      return null;
    }
    // Default: most recent active session, or legacy
    for (const [, session] of [...activeSessions].reverse()) {
      if (session.status !== 'done') return session.state.getSnapshot();
    }
    if (activeConnectionId && ingestSessions.has(activeConnectionId)) {
      return ingestSessions.get(activeConnectionId).state.getSnapshot();
    }
    // Return most recent active session even if done
    if (activeSessions.size > 0) {
      return [...activeSessions.values()].pop().state.getSnapshot();
    }
    return null;
  }

  function broadcastToDashboard(event, sessionId) {
    const msg = JSON.stringify({ type: 'event', data: event, sessionId });
    for (const ws of dashboardClients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  function broadcastSessionStatus(session) {
    const msg = JSON.stringify({
      type: 'session_status',
      sessionId: session.sessionId,
      status: session.status,
      pendingApproval: session.pendingApproval,
    });
    for (const ws of dashboardClients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  // ================================================================
  // HTTP helpers
  // ================================================================

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }

  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  function parseRoute(urlPath) {
    // /api/sessions/:id/:action
    const m = urlPath.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
    if (m) return { id: decodeURIComponent(m[1]), action: m[2] || null };
    return null;
  }

  // ================================================================
  // HTTP server
  // ================================================================

  const httpServer = http.createServer(async (req, res) => {
    const [urlPath] = req.url.split('?');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Connection-Id');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // --- Health ---
    if (urlPath === '/api/health' && req.method === 'GET') {
      json(res, 200, { ok: true, activeSessions: activeSessions.size });
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
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }

    // --- List sessions ---
    if (urlPath === '/api/sessions' && req.method === 'GET') {
      const stored = store.listSessions();
      // Merge active session status
      for (const s of stored) {
        const active = [...activeSessions.values()].find(a => a.sessionId === s.id);
        if (active) {
          s.status = active.status;
          s.pendingApproval = active.pendingApproval;
          s.cwd = active.cwd;
        }
      }
      // Add active sessions not yet stored
      for (const [id, active] of activeSessions) {
        if (!stored.find(s => s.id === id)) {
          stored.unshift({
            id,
            claudeSessionId: active.claudeSessionId,
            model: active.model || active.state.model,
            startTime: active.state.startTime,
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

      // GET /api/sessions/:id → load stored events (existing behavior)
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

      // DELETE /api/sessions/:id (kills + deletes stored data)
      if (!action && req.method === 'DELETE') {
        killSession(id);
        const deleted = store.deleteSession(id);
        json(res, deleted ? 200 : 404, { deleted });
        return;
      }

      // GET /api/sessions/:id/status
      if (action === 'status' && req.method === 'GET') {
        const session = activeSessions.get(id);
        if (!session) {
          // Check stored sessions
          if (store.hasSession(id)) {
            json(res, 200, { sessionId: id, status: 'done' });
          } else {
            json(res, 404, { error: 'Session not found' });
          }
          return;
        }
        const s = session.state;
        const toolCalls = s.events.filter(e => e.kind === 'tool_call' || (e.kind === 'block_start' && e.blockType === 'tool_use')).length;
        const result = {
          sessionId: id,
          claudeSessionId: session.claudeSessionId,
          status: session.status,
          model: s.model,
          cwd: session.cwd,
          toolCalls,
          eventCount: s.events.length,
          costUsd: s.usage.costUsd,
          error: session.error,
        };
        if (session.pendingApproval) {
          result.pendingApproval = session.pendingApproval;
        }
        json(res, 200, result);
        return;
      }

      // GET /api/sessions/:id/events?last=N&since=cursor
      if (action === 'events' && req.method === 'GET') {
        const session = activeSessions.get(id);
        const reqUrl = new URL(req.url, `http://localhost:${port}`);
        const last = parseInt(reqUrl.searchParams.get('last')) || 0;
        const since = reqUrl.searchParams.get('since'); // event ID

        let events;
        if (session) {
          events = session.state.events;
        } else {
          events = store.loadSession(id);
          if (!events) { json(res, 404, { error: 'Session not found' }); return; }
        }

        // Filter by cursor
        if (since) {
          const idx = events.findIndex(e => e.id === since);
          if (idx !== -1) events = events.slice(idx + 1);
        }

        // Limit
        if (last > 0) events = events.slice(-last);

        json(res, 200, { sessionId: id, events });
        return;
      }

      // GET /api/sessions/:id/result
      if (action === 'result' && req.method === 'GET') {
        const session = activeSessions.get(id);
        let events;
        if (session) {
          events = session.state.events;
        } else {
          events = store.loadSession(id);
          if (!events) { json(res, 404, { error: 'Session not found' }); return; }
        }
        // Find last session_end event
        const endEvent = [...events].reverse().find(e => e.kind === 'session_end');
        if (endEvent) {
          json(res, 200, { sessionId: id, result: endEvent.result, costUsd: endEvent.costUsd, isError: endEvent.isError });
        } else {
          // Collect text from text events
          const texts = events.filter(e => e.kind === 'text').map(e => e.text);
          json(res, 200, { sessionId: id, result: texts.join('') || null, status: session ? session.status : 'done' });
        }
        return;
      }

      // POST /api/sessions/:id/message
      if (action === 'message' && req.method === 'POST') {
        const session = activeSessions.get(id);
        if (!session) { json(res, 404, { error: 'Session not found or not active' }); return; }
        try {
          const body = JSON.parse(await readBody(req));
          if (!body.prompt) { json(res, 400, { error: 'prompt required' }); return; }
          sendPromptToSession(session, body.prompt);
          json(res, 200, { sent: true, status: session.status });
        } catch (err) {
          json(res, 400, { error: err.message });
        }
        return;
      }

      // POST /api/sessions/:id/approve
      if (action === 'approve' && req.method === 'POST') {
        const session = activeSessions.get(id);
        if (!session) { json(res, 404, { error: 'Session not found or not active' }); return; }
        if (!session.pendingApproval) { json(res, 400, { error: 'No pending approval' }); return; }
        approveSession(session);
        json(res, 200, { approved: true });
        return;
      }

      // POST /api/sessions/:id/close (kill process + socket, keep stored data)
      if (action === 'close' && req.method === 'POST') {
        const killed = killSession(id);
        if (!killed) {
          // Already done or not active — that's fine
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

      // POST /api/sessions/:id/deny
      if (action === 'deny' && req.method === 'POST') {
        const session = activeSessions.get(id);
        if (!session) { json(res, 404, { error: 'Session not found or not active' }); return; }
        if (!session.pendingApproval) { json(res, 400, { error: 'No pending approval' }); return; }
        let message = '';
        try { message = JSON.parse(await readBody(req)).message || ''; } catch {}
        denySession(session, message);
        json(res, 200, { denied: true });
        return;
      }
    }

    // --- Legacy: queue-prompt (for old send mode) ---
    if (urlPath === '/api/queue-prompt' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const token = `tok_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        pendingPrompts.set(token, { prompt: body.prompt || '' });
        json(res, 200, { token });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
      return;
    }

    // --- Legacy: ingest API (pipe mode) ---
    if (urlPath === '/api/ingest' && req.method === 'POST') {
      const connectionId = req.headers['x-connection-id'];
      if (!connectionId) { json(res, 400, { error: 'Missing X-Connection-Id header' }); return; }
      try {
        const body = await readBody(req);
        const events = parseLine(body.trim());
        handleIngestEvents(connectionId, events);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }

    if (urlPath === '/api/ingest/close' && req.method === 'POST') {
      const connectionId = req.headers['x-connection-id'];
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

  wss.on('connection', (ws, req) => {
    const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);

    // Claude CLI --sdk-url connection
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

  function handleClaudeWs(ws, reqUrl) {
    const sessionId = reqUrl.searchParams.get('session');
    const token = reqUrl.searchParams.get('token');

    // Match to active session or legacy token
    let session = sessionId ? activeSessions.get(sessionId) : null;
    const legacyPromptData = token ? pendingPrompts.get(token) : null;
    if (token) pendingPrompts.delete(token);

    const connectionId = `sdk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (session) {
      session.ws = ws;

      // Send the initial prompt immediately (protocol: server sends user msg first)
      if (session.prompt) {
        const userMsg = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: session.prompt },
          parent_tool_use_id: null,
          session_id: session.claudeSessionId || '',
        }) + '\n';
        ws.send(userMsg);
        session.prompt = null; // consumed
        session.status = 'running';
        session.gotResult = false;
        broadcastSessionStatus(session);
      }
    } else if (legacyPromptData && legacyPromptData.prompt) {
      // Legacy mode: send prompt immediately on connect
      const userMsg = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: legacyPromptData.prompt },
        parent_tool_use_id: null,
        session_id: '',
      }) + '\n';
      ws.send(userMsg);
    }

    ws.on('message', (data) => {
      const raw = data.toString();
      const lines = raw.split('\n').filter(l => l.trim());

      for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        // --- Handle control_request (permission) ---
        if (obj.type === 'control_request' && obj.request && obj.request.subtype === 'can_use_tool') {
          if (session && !session.autoApprove) {
            // Queue for external approval
            session.pendingApproval = {
              requestId: obj.request_id,
              toolName: obj.request.tool_name,
              input: obj.request.tool_input,
            };
            session.status = 'waiting_approval';
            broadcastSessionStatus(session);

            // Also broadcast as event for dashboard timeline
            const approvalEvent = {
              id: `evt_${Date.now()}_approval`,
              ts: Date.now(),
              kind: 'approval_request',
              toolName: obj.request.tool_name,
              input: obj.request.tool_input,
              requestId: obj.request_id,
            };
            if (session) {
              session.state.addEvent(approvalEvent);
              store.appendEvent(session.sessionId, approvalEvent);
              broadcastToDashboard(approvalEvent, session.sessionId);
            }
          } else {
            // Auto-approve
            const response = JSON.stringify({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: obj.request_id,
                response: { behavior: 'allow' },
              },
            }) + '\n';
            ws.send(response);
          }
          continue;
        }

        // --- Ignore keep_alive ---
        if (obj.type === 'keep_alive') continue;

        // --- Parse and ingest ---
        const events = parseLine(line);
        handleIngestEvents(connectionId, events, session);

        // --- Track session state ---
        if (session) {
          if (obj.type === 'system' && obj.subtype === 'init') {
            session.claudeSessionId = obj.session_id;

            // If idle with queued prompts, send next
            if (session.status === 'idle' && session.promptQueue.length > 0) {
              const nextPrompt = session.promptQueue.shift();
              sendPromptToSession(session, nextPrompt);
            }
          }

          if (obj.type === 'result') {
            // Turn complete — transition to idle
            session.status = 'idle';
            broadcastSessionStatus(session);

            // Send queued prompt if any
            if (session.promptQueue.length > 0) {
              // Small delay to let CLI settle before next turn
              setTimeout(() => {
                if (session.status === 'idle' && session.promptQueue.length > 0) {
                  const nextPrompt = session.promptQueue.shift();
                  sendPromptToSession(session, nextPrompt);
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
        if (session.status !== 'error') {
          session.status = 'done';
        }
        // Emit session_complete event
        const endEvent = {
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
        // Legacy mode
        closeIngest(connectionId);
      }
    });

    ws.on('error', () => {});
  }

  // ================================================================

  function start() {
    return new Promise((resolve) => {
      httpServer.listen(port, () => resolve());
    });
  }

  return { start, broadcastToDashboard, getSnapshot, httpServer };
}

module.exports = { createServer };
