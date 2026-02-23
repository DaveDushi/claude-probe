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
