# Claude Probe: OpenClaw Integration

## Status: Phases 1-4 Complete, Phase 5 (Dashboard) Pending

## What's Done

### Phase 1: --sdk-url protocol + server-side spawning ✅
- Server sends `user` message first (fixed protocol)
- Server spawns Claude CLI with `--sdk-url` pointing back to itself
- Auto-detects claude binary (checks common install paths)
- Cleans env vars to avoid nesting guard (CLAUDECODE, etc.)

### Phase 2: Permission control API ✅
- `POST /api/sessions/:id/approve` — approve pending tool use
- `POST /api/sessions/:id/deny` — deny with reason
- `--auto-approve` flag for fire-and-forget mode
- Without auto-approve, control_requests are queued for external approval
- `approval_request` events broadcast to dashboard

### Phase 3: Multi-turn + session control ✅
- `POST /api/sessions/:id/message` — send follow-up prompt
- `GET /api/sessions/:id/events?last=N` — event log
- `GET /api/sessions/:id/result` — final text
- `DELETE /api/sessions/:id` — kill session
- State machine: starting → running → idle → running → ... → done
- Prompt queue for messages sent while CLI is busy

### Phase 4: CLI tool ✅
- Commands: serve, new, status, events, send, approve, deny, result, sessions
- Plain text output, token-efficient for AI agents
- `bin` in package.json: `probe` and `claude-probe` (global install)
- `--port`, `--model`, `--auto-approve`, `--cwd`, `--permission-mode`, `--allowedTools`

### Phase 5: Dashboard updates (TODO)
- [ ] Show pending approval state on timeline (highlighted card)
- [ ] Show multi-session support (session picker or tabs)
- [ ] Show which external client sent each prompt

## Test Results
- ✅ Session creation (returns immediately with ID)
- ✅ Auto-approve mode (Claude runs to completion)
- ✅ Multi-turn conversation (send follow-up, get new result)
- ✅ Status, events, result commands
- ✅ Sessions list (merges active + stored)
- ✅ Session cost tracking ($0.0777 over 2 turns)
- ⚠️ Permission queuing (code ready, needs restrictive --permission-mode to trigger)

## How to Test

```bash
# Terminal 1: Start server
node probe.js serve --port 3456

# Terminal 2: Create session
SESSION=$(node probe.js new -p "Say hello" --auto-approve)
echo $SESSION

# Check status
node probe.js status $SESSION

# Get events
node probe.js events $SESSION

# Get result
node probe.js result $SESSION

# Send follow-up
node probe.js send $SESSION -p "Now say goodbye"
sleep 5
node probe.js result $SESSION

# List all sessions
node probe.js sessions

# Test permission mode (will queue tool approvals)
SESSION2=$(node probe.js new -p "Create a file called test.txt")
sleep 5
node probe.js status $SESSION2
# If waiting_approval:
node probe.js approve $SESSION2
# or:
node probe.js deny $SESSION2 -m "don't create files"
```
