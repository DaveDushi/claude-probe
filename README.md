# claude-probe

CLI + browser dashboard for controlling and monitoring Claude Code sessions.

Spawn isolated Claude Code sessions as background processes, monitor them in real-time through a browser dashboard, and control tool permissions — all from the command line or HTTP API.

## Features

- **Session spawning** — create Claude Code sessions as background processes with custom prompts, models, and working directories
- **Real-time dashboard** — browser UI with live event timeline, token usage, cost tracking, and tool statistics
- **Tool permission control** — approve or deny tool-use requests manually, or auto-approve everything
- **Multi-turn conversations** — send follow-up prompts to running sessions
- **Multi-session management** — list, search, sort, filter, and delete across all sessions
- **HTTP + WebSocket API** — full programmatic control for scripts and agent orchestration
- **Session persistence** — all sessions saved as `.jsonl` files for later review
- **Zero build step** — vanilla JS, single dependency (`ws`), runs directly with Node.js

## Install

### Global install from GitHub

```bash
npm install -g github:DaveDushi/claude-probe
probe serve
```

### Clone and run

```bash
git clone https://github.com/DaveDushi/claude-probe.git
cd claude-probe
npm install
node probe.js serve
```

### One-off with npx

```bash
npx github:DaveDushi/claude-probe serve
```

## Quick Start

```bash
# Terminal 1: Start the server (opens dashboard in browser)
probe serve

# Terminal 2: Create a session
probe new -p "Fix the authentication bug in auth.py" --cwd /my/project

# Check on it
probe status <session-id>
probe events <session-id> --last 10

# Get the result when done
probe result <session-id>
```

## CLI Reference

| Command | Aliases | Purpose |
|---------|---------|---------|
| `probe serve` | `start` | Start HTTP + WebSocket server and browser dashboard |
| `probe new -p "prompt"` | `create` | Spawn a new Claude Code session (prints session ID) |
| `probe status <id>` | | Get session status, model, cost, tool count |
| `probe events <id>` | `log` | Get recent events from a session |
| `probe send <id> -p "prompt"` | `message` | Send a follow-up message to an idle session |
| `probe approve <id>` | | Approve a pending tool-use request |
| `probe deny <id>` | | Deny a pending tool-use request |
| `probe close <id>` | `stop` | Kill session process, keep stored data |
| `probe result <id>` | | Get the final result text |
| `probe sessions` | `list`, `ls` | List all sessions with status, cost, preview |

### Session Creation Flags

| Flag | Purpose |
|------|---------|
| `-p, --prompt "text"` | Prompt for the session (required) |
| `--model <model>` | Claude model to use |
| `--auto-approve` | Auto-approve all tool use (no manual gating) |
| `--cwd <dir>` | Working directory for the Claude process |
| `-r, --resume <session-id>` | Resume an existing Claude session |
| `--permission-mode <mode>` | Passthrough to Claude CLI |
| `--allowedTools <tools>` | Passthrough to Claude CLI |

### Server Flags

| Flag | Purpose |
|------|---------|
| `--port <port>` | Server port (default: 3456) |
| `--data-dir <dir>` | Session storage directory (default: `./sessions/`) |
| `--no-browser` | Don't auto-open the dashboard |
| `--claude-path <path>` | Custom path to the claude binary |

`--port` is global and works with any command.

## HTTP API

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `GET` | `/api/health` | — | Health check |
| `POST` | `/api/sessions` | `{ prompt, model?, autoApprove?, cwd?, resumeSessionId?, flags? }` | Create session |
| `GET` | `/api/sessions` | — | List all sessions |
| `GET` | `/api/sessions/:id` | — | Load full event log |
| `DELETE` | `/api/sessions/:id` | — | Kill + delete session and data |
| `GET` | `/api/sessions/:id/status` | — | Status, cost, model, pending approval |
| `GET` | `/api/sessions/:id/events?last=N&since=cursor` | — | Paginated events |
| `GET` | `/api/sessions/:id/result` | — | Final result text and cost |
| `POST` | `/api/sessions/:id/message` | `{ prompt }` | Send follow-up message |
| `POST` | `/api/sessions/:id/approve` | `{}` | Approve pending tool use |
| `POST` | `/api/sessions/:id/deny` | `{ message? }` | Deny pending tool use |
| `POST` | `/api/sessions/:id/close` | `{}` | Kill process, keep data |

## Architecture

```
probe.js          CLI entry point — parses commands, talks to server via HTTP
lib/server.js     HTTP + WebSocket server, spawns Claude CLI processes
lib/store.js      JSONL session persistence (one file per session)
lib/state.js      In-memory session state tracking
lib/parser.js     Claude stream-json NDJSON parser
public/           Browser dashboard (vanilla HTML/JS/CSS)
sessions/         Stored session logs (.jsonl files)
```

**How it works:** `probe serve` starts an HTTP server. `probe new` sends a POST to the server, which spawns a `claude` child process connected via `--sdk-url` WebSocket. All Claude output is parsed in real-time, persisted to `.jsonl` files, and broadcast to connected dashboard clients. Tool permission requests are intercepted and gated (approve/deny) unless `--auto-approve` is set.

## Requirements

- **Node.js >= 18**
- **Claude Code CLI** installed and authenticated

Works on Windows, macOS, and Linux.

## License

MIT
