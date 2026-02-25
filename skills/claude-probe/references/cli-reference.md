# CLI & API Reference

## probe new — Session Creation

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
| `--max-turns <n>` | Maximum agentic turns before stopping |
| `--max-budget-usd <n>` | Spending limit for the session |

## probe serve — Server

| Flag | Purpose |
|------|---------|
| `--port <port>` | Server port (default: 3456) |
| `--data-dir <dir>` | Session storage directory |
| `--no-browser` | Don't auto-open the dashboard |
| `--claude-path <path>` | Custom path to the claude binary |

## HTTP API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/diagnostics` | Server + session health diagnostics |
| `POST` | `/api/sessions` | Create session (body: `{ prompt, cwd, model?, autoApprove? }`) |
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id/status` | Session status, phase, stuck detection |
| `GET` | `/api/sessions/:id/events` | Session events (query: `?last=N`) |
| `GET` | `/api/sessions/:id/result` | Final result text |
| `POST` | `/api/sessions/:id/message` | Send follow-up (body: `{ prompt }`) |
| `POST` | `/api/sessions/:id/approve` | Approve pending tool use |
| `POST` | `/api/sessions/:id/deny` | Deny pending tool use |
| `POST` | `/api/sessions/:id/close` | Kill session process |
| `DELETE` | `/api/sessions/:id` | Delete session and all data |

## Enriched Status Fields

`probe status <id>` returns these fields:

| Field | Description |
|-------|-------------|
| `status` | Top-level state: `starting`, `running`, `idle`, `waiting_approval`, `done`, `error` |
| `phase` | Sub-state: `waiting_for_ws`, `initializing`, `processing`, `awaiting_approval` |
| `stuckForMs` | Milliseconds since last activity (warning if > 30s) |
| `errorCode` | Structured error: `startup_timeout`, `first_event_timeout`, `heartbeat_timeout`, `spawn_error` |
| `lastActivityAt` | Timestamp of last event |
| `costUsd` | Running cost for the session |
| `turns` | Number of completed agentic turns |

## Event Types

| Event | When |
|-------|------|
| `session_timeout` | Watchdog timeout (includes `reason`, `message`) |
| `approval_request` | Tool use needs manual approval |
| `approval_granted` | Tool use request approved |
| `approval_denied` | Tool use request denied |
| `tool_use` | Tool executed |
| `text` | Claude produced text output |
| `error` | Error occurred |

## Polling Pattern

```bash
# Wait for a session to finish
ID=$(probe new -p "..." --cwd ./project --auto-approve)
while true; do
  STATUS=$(probe status "$ID" --json | jq -r '.status')
  case "$STATUS" in
    done|error) break ;;
    *) sleep 5 ;;
  esac
done
probe result "$ID"
```
