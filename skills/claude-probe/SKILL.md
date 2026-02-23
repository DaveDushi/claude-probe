---
name: claude-probe
description: Spawn, monitor, and control Claude Code sessions from the CLI or HTTP API with a real-time browser dashboard.
version: 2.1.0
user-invocable: true
homepage: https://github.com/DaveDushi/claude-probe
metadata:
  openclaw:
    emoji: "🔬"
    homepage: https://github.com/DaveDushi/claude-probe
    os:
      - darwin
      - linux
      - win32
    requires:
      bins:
        - node
        - claude
      env: []
    install:
      - id: npm-global
        kind: node
        package: github:DaveDushi/claude-probe
        bins:
          - probe
        label: Install via npm (from GitHub)
---

# claude-probe

CLI + browser dashboard for controlling and monitoring Claude Code sessions.

Spawn isolated Claude Code sessions as background processes, monitor them in real-time through a browser dashboard, and control tool permissions -- all from the command line or HTTP API.

## MANDATORY: Probe-Only Execution

**ALL work MUST go through probe sessions. NEVER bypass probe to do work directly.**

You are an orchestrator. Your job is to plan work, spawn probe sessions to execute it, and verify the results. You do not write code, edit files, or run commands yourself -- probe sessions do that for you.

Rules:
1. Every code change, test run, or file operation goes through `probe new` or `probe send`.
2. If a session fails, diagnose with `probe doctor` and retry. Do NOT fall back to doing the work yourself.
3. If the server is not running, start it with `probe serve --no-browser` first.
4. Reading probe output (status, events, result) is orchestration, not bypassing.
5. Always use `--auto-approve` for autonomous sessions. This correctly sets `--permission-mode bypassPermissions` on the subprocess.

## Patience and Retry Protocol

Sessions take time. The Claude Code subprocess must spawn, connect via WebSocket, and begin processing.

**Do NOT give up after one failure.** Follow this escalation:

1. **Wait** -- sessions in `starting` may take up to 45 seconds. Poll with `probe status` every 5-10 seconds.
2. **Check phase** -- status now includes `phase` (`waiting_for_ws`, `initializing`, `processing`). Use it.
3. **Diagnose** -- run `probe doctor` if a session errors or seems stuck.
4. **Retry** -- if errorCode is `startup_timeout`, `first_event_timeout`, or `heartbeat_timeout`, close and respawn. Transient failures are common.
5. **Retry limit** -- up to 3 retries per task. Always run `probe doctor` between retries.
6. **Never bypass** -- after 3 failures, report the issue to the user. Do not do the work yourself.

## Setup

Install globally:

```bash
npm install -g github:DaveDushi/claude-probe
```

Or run with npx:

```bash
npx github:DaveDushi/claude-probe serve
```

Requires **Node.js >= 18** and the **Claude Code CLI** installed and authenticated.

## Usage

### Starting the server

```bash
probe serve
```

This starts the HTTP + WebSocket server and opens the browser dashboard.

### Spawning sessions

```bash
probe new -p "Fix the authentication bug in auth.py" --cwd /my/project --auto-approve
```

Flags:

| Flag | Purpose |
|------|---------|
| `-p, --prompt "text"` | Prompt for the session (required) |
| `--model <model>` | Claude model to use |
| `--auto-approve` | Auto-approve all tool use + set `--permission-mode bypassPermissions` |
| `--cwd <dir>` | Working directory for the Claude process |
| `-r, --resume <id>` | Resume an existing session |
| `--permission-mode <mode>` | Passthrough to Claude CLI (overrides auto-approve default) |
| `--allowedTools <tools>` | Passthrough to Claude CLI |
| `--dangerously-skip-permissions` | Passthrough to Claude CLI |

### Monitoring and control

```bash
probe status <session-id>
probe events <session-id> --last 10
probe result <session-id>
probe doctor                        # server + session health check
```

### Multi-turn conversations

```bash
probe send <session-id> -p "Now add tests for that fix"
```

### Tool permission gating

```bash
probe approve <session-id>
probe deny <session-id>
```

### Session management

```bash
probe sessions                      # list all sessions
probe close <session-id>            # stop a session
probe doctor                        # diagnose server and session health
```

## HTTP API

All commands are also available via HTTP for scripts and agent orchestration:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/diagnostics` | Server and session health diagnostics |
| `POST` | `/api/sessions` | Create session |
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id/status` | Get session status, phase, stuck detection |
| `GET` | `/api/sessions/:id/events` | Get session events |
| `GET` | `/api/sessions/:id/result` | Get final result |
| `POST` | `/api/sessions/:id/message` | Send follow-up message |
| `POST` | `/api/sessions/:id/approve` | Approve pending tool use |
| `POST` | `/api/sessions/:id/deny` | Deny pending tool use |
| `POST` | `/api/sessions/:id/close` | Kill session process |
| `DELETE` | `/api/sessions/:id` | Delete session and data |

## Server flags

| Flag | Purpose |
|------|---------|
| `--port <port>` | Server port (default: 3456) |
| `--data-dir <dir>` | Session storage directory |
| `--no-browser` | Don't auto-open the dashboard |
| `--claude-path <path>` | Custom path to the claude binary |

## Session Lifecycle

```
starting --> running --> idle              (turn complete)
                     --> waiting_approval   (tool needs approval)
                     --> done               (process exited)
                     --> error              (spawn failed or timeout)

Watchdog timeouts (automatic):
  starting --[45s]--> error (startup_timeout)
  running  --[60s]--> error (first_event_timeout)
  running  --[120s]-> error (heartbeat_timeout)
```

### Enriched Status

`probe status` now includes:
- `phase`: sub-state (`waiting_for_ws`, `initializing`, `processing`, `awaiting_approval`)
- `stuckForMs`: ms since last activity (warning if > 30s)
- `errorCode`: structured error type (`startup_timeout`, `first_event_timeout`, `heartbeat_timeout`, `spawn_error`)
- `lastActivityAt`: timestamp of last event

### New Events

| Event | When |
|-------|------|
| `session_timeout` | Watchdog timeout (includes `reason`, `message`) |
| `approval_granted` | Tool-use request approved |
| `approval_denied` | Tool-use request denied |

## Diagnostics

### `probe doctor`

Checks server reachability, detailed session diagnostics (process alive, WS connected, stuck detection), and WebSocket connectivity. Run this whenever a session misbehaves -- before retrying.

### Troubleshooting Quick Reference

| Symptom | Cause | Fix |
|---------|-------|-----|
| Session stuck in "starting" | WS never connected | `probe doctor`, verify `claude` CLI, retry |
| `startup_timeout` error | 45s elapsed without WS | Close and respawn |
| `heartbeat_timeout` error | 120s no events | Check `probe doctor` for proc/ws status, retry |
| `spawn_error` | Claude binary not found | Check `claude --version`, use `--claude-path` |
| Server unreachable | Server not running | `probe serve --no-browser` |
| ZodError on tool calls | Permission mode mismatch | Use `--auto-approve` (auto-sets bypassPermissions) |

## Workflow: Plan, Execute, Verify

Always follow this three-phase workflow when using claude-probe. This is not optional. Every task must go through all three phases. Skipping phases or bypassing probe to do work directly defeats the purpose of using this skill.

### Phase 1: Plan

Before spawning any session, think through:

1. **What needs to happen?** Break the task into discrete, testable steps.
2. **What order?** Identify dependencies between steps. Independent steps can run in parallel.
3. **What could go wrong?** Anticipate failure modes and how you'll detect them.
4. **What does success look like?** Define concrete verification criteria for each step.

Write your plan out explicitly. For example:

```
Plan:
1. Read the current auth module to understand the structure
2. Fix the token refresh race condition in auth.py
3. Add unit tests covering the race condition
4. Run the test suite to verify nothing broke
Verification: all tests pass, token refresh works under concurrent requests
```

### Phase 2: Execute

Now spawn sessions to carry out each step. Craft prompts that are specific and scoped:

```bash
# Bad -- vague, no guardrails
probe new -p "Fix auth" --cwd ./project --auto-approve

# Good -- specific, scoped, with constraints
probe new -p "In auth.py, the token refresh at line 84 has a race condition when multiple requests hit refresh simultaneously. Add a lock so only one refresh executes at a time. Do not change the public API." --cwd ./project --auto-approve
```

Monitor progress as sessions run:

```bash
probe status <session-id>
probe events <session-id> --last 5
```

If a session fails or times out during execution:

```bash
probe doctor                         # check server health first
probe close <session-id>             # clean up failed session
# Retry with the same or refined prompt
ID=$(probe new -p "..." --cwd ./project --auto-approve)
```

Do not abandon probe and do the work yourself. Diagnose, retry, and only escalate to the user after 3 failed attempts.

### Phase 3: Verify

Never trust that a session did the right thing. Always verify:

1. **Read the result** -- check what the session actually did.
   ```bash
   probe result <session-id>
   ```

2. **Run tests** -- spawn a verification session if needed.
   ```bash
   probe new -p "Run the full test suite and report any failures" --cwd ./project --auto-approve
   ```

3. **Diff the changes** -- check that nothing unexpected was modified.
   ```bash
   probe new -p "Run git diff and summarize all changes made" --cwd ./project --auto-approve
   ```

4. **Fix issues** -- if verification fails, diagnose and send a follow-up or spawn a new session.
   ```bash
   probe send <session-id> -p "The tests in test_auth.py are failing with TimeoutError. Fix the lock implementation."
   ```

Only move on when verification passes. If it doesn't, loop back: re-plan, re-execute, re-verify.

## Examples

Spawn a session and wait for the result:

```bash
probe serve --no-browser &
ID=$(probe new -p "Refactor the utils module" --cwd ./my-project --auto-approve)
probe result "$ID"
```

Run multiple agents in parallel:

```bash
probe new -p "Write unit tests for api.js" --cwd ./project --auto-approve
probe new -p "Add input validation to forms.js" --cwd ./project --auto-approve
probe sessions
```
