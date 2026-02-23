---
name: claude-probe
description: Spawn, monitor, and control Claude Code sessions from the CLI or HTTP API with a real-time browser dashboard.
version: 2.0.0
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

Spawn isolated Claude Code sessions as background processes, monitor them in real-time through a browser dashboard, and control tool permissions — all from the command line or HTTP API.

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
probe new -p "Fix the authentication bug in auth.py" --cwd /my/project
```

Flags:

| Flag | Purpose |
|------|---------|
| `-p, --prompt "text"` | Prompt for the session (required) |
| `--model <model>` | Claude model to use |
| `--auto-approve` | Auto-approve all tool use |
| `--cwd <dir>` | Working directory for the Claude process |
| `-r, --resume <id>` | Resume an existing session |
| `--permission-mode <mode>` | Passthrough to Claude CLI |
| `--allowedTools <tools>` | Passthrough to Claude CLI |

### Monitoring and control

```bash
probe status <session-id>
probe events <session-id> --last 10
probe result <session-id>
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
probe sessions          # list all sessions
probe close <session-id> # stop a session
```

## HTTP API

All commands are also available via HTTP for scripts and agent orchestration:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/sessions` | Create session |
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id/status` | Get session status |
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

## Workflow: Plan, Execute, Verify

Always follow this three-phase workflow when using claude-probe. This produces dramatically better results than jumping straight into execution.

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
# Bad — vague, no guardrails
probe new -p "Fix auth" --cwd ./project --auto-approve

# Good — specific, scoped, with constraints
probe new -p "In auth.py, the token refresh at line 84 has a race condition when multiple requests hit refresh simultaneously. Add a lock so only one refresh executes at a time. Do not change the public API." --cwd ./project --auto-approve
```

Monitor progress as sessions run:

```bash
probe status <session-id>
probe events <session-id> --last 5
```

### Phase 3: Verify

Never trust that a session did the right thing. Always verify:

1. **Read the result** — check what the session actually did.
   ```bash
   probe result <session-id>
   ```

2. **Run tests** — spawn a verification session if needed.
   ```bash
   probe new -p "Run the full test suite and report any failures" --cwd ./project --auto-approve
   ```

3. **Diff the changes** — check that nothing unexpected was modified.
   ```bash
   probe new -p "Run git diff and summarize all changes made" --cwd ./project --auto-approve
   ```

4. **Fix issues** — if verification fails, diagnose and send a follow-up or spawn a new session.
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
