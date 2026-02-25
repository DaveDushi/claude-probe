# Setup & Installation

## Requirements

- **Node.js >= 18**
- **Claude Code CLI** installed and authenticated (`claude --version` to verify)

## Install

Global install:
```bash
npm install -g github:DaveDushi/claude-probe
```

Or run with npx (no install):
```bash
npx github:DaveDushi/claude-probe serve
```

## Starting the Server

```bash
# With browser dashboard
probe serve

# Headless (for agent use)
probe serve --no-browser

# Custom port
probe serve --port 8080

# Custom data directory
probe serve --data-dir ./my-sessions
```

The server must be running before spawning sessions. If you get "server unreachable", start it first.

## Custom Claude Path

If the `claude` binary isn't on PATH:
```bash
probe serve --claude-path /usr/local/bin/claude
```

## Common Issues

| Issue | Fix |
|-------|-----|
| `claude` not found | Install Claude Code CLI, or use `--claude-path` |
| Port already in use | Use `--port` with a different port |
| Sessions fail immediately | Run `claude --version` to verify CLI works |
| Permission errors | Check Node.js version (`node --version` >= 18) |
| WebSocket won't connect | Firewall may be blocking localhost; check `probe doctor` |
