# Orchestration Patterns

Advanced patterns for multi-agent workflows through probe.

## Plan → Review → Build

The most important pattern. Use Claude Code's plan mode to explore and design before committing to implementation:

```bash
# 1. Spawn a plan-mode session (read-only, capped turns)
PLAN_ID=$(probe new -p "Plan how to add OAuth2 support to the auth module. Explore existing code, identify all files that need changes, and propose a step-by-step plan." \
  --cwd ./project --permission-mode plan --max-turns 5)

# 2. Review the plan
probe result "$PLAN_ID"

# 3. Not happy? Refine it
probe send "$PLAN_ID" -p "Also account for the existing session middleware. And keep backward compat with API key auth."
probe result "$PLAN_ID"

# 4. Happy? Build from the plan
PLAN=$(probe result "$PLAN_ID")
BUILD_ID=$(probe new -p "Execute this plan: $PLAN" --cwd ./project --auto-approve --max-turns 20)

# 5. Verify the build
probe result "$BUILD_ID"
```

**Why this works:** Plan mode sets `--permission-mode plan` which makes the session read-only — it can explore files but can't write anything. This means you can iterate on the design cheaply before committing to an expensive implementation session. The orchestrator stays in control of what gets built.

**When to skip planning:** Trivial tasks (single-file fix, run tests, generate docs) don't need a plan session. Go straight to `--auto-approve`.

## Parallel Fan-Out

Run independent tasks simultaneously, then collect results:

```bash
# Spawn parallel sessions
ID1=$(probe new -p "Write unit tests for auth module" --cwd ./project --auto-approve)
ID2=$(probe new -p "Write unit tests for payments module" --cwd ./project/payments --auto-approve)
ID3=$(probe new -p "Update API documentation" --cwd ./project --auto-approve)

# Wait for all to complete
for ID in $ID1 $ID2 $ID3; do
  while true; do
    STATUS=$(probe status "$ID" --json | jq -r '.status')
    case "$STATUS" in
      done|error) break ;;
      *) sleep 5 ;;
    esac
  done
done

# Collect results
probe result "$ID1"
probe result "$ID2"
probe result "$ID3"
```

**Important:** Parallel sessions should work on different files or directories. Two sessions editing the same file will conflict.

## Resume vs New Session

**Use `probe send`** when the context from previous turns is needed:
```bash
# Continue a conversation
probe send <id> -p "Now add error handling to the function you just wrote"
```

**Use `probe new -r`** when the Claude Code session itself needs to resume:
```bash
# Resume the Claude Code session (preserves full session state)
probe new -r <session-id> -p "Continue from where you left off"
```

**Use `probe new`** when starting fresh or when context would be confusing:
```bash
# Clean start for a new task
probe new -p "..." --cwd ./project --auto-approve
```

Rule of thumb: if the follow-up directly builds on what the session just did, use `probe send`. If it's a related but separate task, start a new session.

## Cost Tracking

Monitor spending across sessions:

```bash
# Check individual session cost
probe status <id>   # includes costUsd field

# List all sessions and their costs
probe sessions      # shows cost per session
```

Set limits proactively:
```bash
# Per-session turn limit
probe new -p "..." --auto-approve --max-turns 10

# Per-session cost limit (passed to Claude Code)
probe new -p "..." --auto-approve -- --max-budget-usd 3.00
```

## Circuit Breaker

Probe has a built-in circuit breaker. After 3 consecutive spawn failures, it rejects new sessions for 30 seconds.

**Detection:**
```bash
probe doctor   # Shows circuit breaker state: closed (healthy) or open (tripped)
```

**Recovery:**
1. Wait for cooldown (30s)
2. Run `probe doctor` to confirm circuit breaker closed
3. Investigate root cause (usually Claude CLI issue or resource exhaustion)
4. Retry with a single session first

## Human-in-the-Loop

For sensitive operations, skip `--auto-approve` and manage approvals:

```bash
# Spawn without auto-approve
ID=$(probe new -p "Refactor the database schema" --cwd ./project)

# Session will pause at tool use requests
probe status "$ID"   # status: waiting_approval

# Review and decide
probe events "$ID" --last 1   # see what tool is requested
probe approve "$ID"           # or: probe deny "$ID"
```

## Failure Escalation

When a session fails, follow this ladder:

1. **Read events** — understand what happened:
   ```bash
   probe events <id> --last 20
   ```

2. **Check health** — is it a probe issue or a task issue?
   ```bash
   probe doctor
   ```

3. **Retry with same prompt** — transient failures are common:
   ```bash
   probe close <id>
   probe new -p "same prompt" --cwd ./project --auto-approve
   ```

4. **Retry with refined prompt** — if the task itself was the problem:
   ```bash
   probe new -p "more specific prompt addressing the failure" --cwd ./project --auto-approve
   ```

5. **Escalate** — after 3 attempts, report to the user with:
   - What was attempted
   - Error messages from `probe events`
   - `probe doctor` output
   - Your best guess at the root cause

## Session Deduplication

Before spawning, always check for existing sessions on the same objective:

```bash
probe sessions   # list all active sessions
```

If you see a session already working on the same task:
- **Running/idle?** → Use `probe send` to continue it
- **Error?** → Close it, then spawn a new one
- **Done?** → Read its result with `probe result` before deciding if you need another
