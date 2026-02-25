---
name: claude-probe
description: "Spawn, monitor, and orchestrate Claude Code sessions as background
  processes via the probe CLI or HTTP API. Use when you need to: run tasks through
  subordinate Claude Code sessions (probe new), poll status and wait for completion
  (probe status, probe result), send multi-turn follow-ups (probe send), run parallel
  multi-agent workflows, enforce cost/turn/concurrency budgets, recover orphaned
  sessions (probe recover), replay sessions through the dashboard (probe replay),
  inspect file artifacts (probe artifacts), manage approval policies (probe policy
  add/list/remove), approve or deny tool use (probe approve, probe deny), use the
  Dalton adapter to execute Dalton-managed tasks as Probe sessions (probe dalton
  work, probe dalton status, probe dalton check), or set up Claude Code project
  infrastructure for a codebase being built through probe (CLAUDE.md, slash commands,
  subagents, hooks, settings, MCP servers)."
license: MIT
metadata:
  openclaw:
    emoji: "\U0001F52C"
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
        package: "github:DaveDushi/claude-probe"
        bins:
          - probe
        label: Install via npm (from GitHub)
---

# claude-probe

CLI + browser dashboard for spawning and controlling Claude Code sessions as background processes.

## Probe-Only Execution

**ALL work MUST go through probe sessions. NEVER bypass probe to do work directly.**

You are an orchestrator. Plan work, spawn probe sessions to execute it, verify results. You do not write code, edit files, or run commands yourself.

1. Every code change, test run, or file operation → `probe new` or `probe send`.
2. If a session fails → diagnose with `probe doctor`, retry. Do NOT fall back to doing work yourself.
3. If the server is not running → `probe serve --no-browser` first.
4. Reading probe output (status, events, result) is orchestration, not bypassing.
5. Always use `--auto-approve` for autonomous sessions (sets `--permission-mode bypassPermissions`).

## Retry Protocol

Sessions take time. The Claude Code subprocess must spawn, connect via WebSocket, and begin processing.

1. **Wait** — sessions in `starting` may take up to 45s. Poll with `probe status` every 5-10s.
2. **Check phase** — status includes `phase` (`waiting_for_ws`, `initializing`, `processing`). Use it.
3. **Diagnose** — run `probe doctor` if a session errors or seems stuck.
4. **Retry** — if errorCode is `startup_timeout`, `first_event_timeout`, or `heartbeat_timeout`, close and respawn.
5. **Limit** — up to 3 retries per task. Always `probe doctor` between retries.
6. **Never bypass** — after 3 failures, report to the user. Do not do the work yourself.

## Avoiding Common Mistakes

These come from real-world stress testing of the manager/developer model:

- **Check before spawning.** Run `probe sessions` first. If a session for the same objective already exists in `starting`/`running`/`idle`, don't spawn a duplicate — join it with `probe send` or close it first.
- **`idle` ≠ `done`.** `idle` means a turn completed but the process is alive and can receive more prompts. `done` means the process exited. When the objective is achieved, run `probe close <id>` explicitly.
- **Plan before you build.** Spawn a `--permission-mode plan` session first to explore and produce a plan (read-only, no writes). Review the plan with `probe result`, refine with `probe send` if needed, then spawn a separate `--auto-approve` session to implement. This prevents wasted builds.
- **Cap turns.** Use `--max-turns 5` for planning sessions, `--max-turns 20` for implementation. Prevents runaway token burn.
- **Verify before declaring success.** After a session finishes, always call `probe result <id>` and check that it actually produced the expected output. A session that reports success but made zero edits may have done nothing.
- **One writer per workspace.** Don't run two implementation sessions writing to the same directory simultaneously — they'll conflict. Parallel sessions should work on different paths or one should be read-only.
- **Close when done.** Always `probe close` completed sessions. Leaving sessions in `idle` wastes resources and confuses status checks.

## Quick Reference

```bash
# Server
probe serve --no-browser            # start server (headless)
probe shutdown                      # stop server and free port

# Sessions
probe new -p "..." --cwd ./project --auto-approve   # spawn
probe send <id> -p "..."            # follow-up message
probe status <id>                   # check status + phase
probe result <id>                   # get final output
probe events <id> --last 10         # recent activity
probe sessions                      # list all
probe sessions --tree               # list with parent/child tree

# Control
probe approve <id>                  # approve pending tool use
probe deny <id>                     # deny pending tool use
probe close <id>                    # stop session
probe close <id> --tree             # stop session + all children
probe doctor                        # health check

# Recovery & Replay
probe recover <id>                  # recover orphaned session (resume Claude)
probe replay <id> --speed 10        # replay session through dashboard
probe artifacts <id>                # list files created/modified/read

# Policies
probe policy add --tool "Write"     # allow tool globally
probe policy add --tool "*" --session <id>  # allow all tools for session
probe policy list                   # list active policies
probe policy remove <id>            # remove a policy

# Dalton Adapter
probe dalton init --cwd . --phases 3  # scaffold .dalton/ with 3 phase files
probe dalton add --phase 1 --title "Set up auth" --priority high  # add task
probe dalton work [task-id] --cwd . --auto-approve  # start next/specific task
probe dalton status --cwd .         # show task/session progress
probe dalton check [task-id] --cwd .  # evaluate done gate, mark complete
```

See [references/cli-reference.md](references/cli-reference.md) for full flag tables, HTTP API endpoints, and status field details.

## Session Lifecycle

```
starting --> running --> idle              (turn complete, can receive more)
                     --> waiting_approval   (tool needs approval)
                     --> done               (process exited)
                     --> error              (spawn failed or timeout)

Timeouts:
  starting --[45s]--> error (startup_timeout)
  running  --[60s]--> error (first_event_timeout)
  running  --[120s]-> error (heartbeat_timeout)
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Stuck in "starting" | `probe doctor`, verify `claude` CLI works, retry |
| `startup_timeout` | Close and respawn |
| `heartbeat_timeout` | `probe doctor` for proc/ws status, retry |
| `spawn_error` | Check `claude --version`, use `--claude-path` |
| Server unreachable | `probe serve --no-browser` |
| ZodError on tool calls | Use `--auto-approve` |

## Workflow: Plan, Execute, Verify

Every task goes through all three phases. No exceptions.

### Phase 1: Plan (use Claude Code's plan mode)

Spawn a session in **plan mode** so Claude explores the codebase and produces a plan without making changes:

```bash
PLAN_ID=$(probe new -p "Plan how to fix the token refresh race condition in auth.py. Explore the codebase, identify affected files, and propose a step-by-step implementation plan." \
  --cwd ./project --permission-mode plan --max-turns 5)
```

Key flags: `--permission-mode plan` (read-only, no writes) and `--max-turns 5` (cap exploration).

**Review the plan:**

```bash
probe result "$PLAN_ID"
```

Read the output. If the plan is good, move to Phase 2. If not, refine it:

```bash
probe send "$PLAN_ID" -p "The plan should also cover adding unit tests. And don't touch the public API."
probe result "$PLAN_ID"
```

Iterate until the plan is solid. Only then proceed to build.

### Phase 2: Execute (build from the approved plan)

Once satisfied with the plan, spawn an implementation session with `--auto-approve` and reference the plan:

```bash
# Feed the approved plan into the build session
PLAN=$(probe result "$PLAN_ID")
BUILD_ID=$(probe new -p "Execute this plan: $PLAN" --cwd ./project --auto-approve)
```

Or give a specific, scoped prompt based on what you learned from the plan:

```bash
BUILD_ID=$(probe new -p "In auth.py, the token refresh at line 84 has a race condition when multiple requests hit refresh simultaneously. Add a lock so only one refresh executes at a time. Do not change the public API. Then add unit tests covering concurrent refresh." \
  --cwd ./project --auto-approve)
```

Monitor progress:

```bash
probe status "$BUILD_ID"
probe events "$BUILD_ID" --last 5
```

On failure: `probe doctor` → `probe close` → respawn with same or refined prompt. Don't bypass probe.

### Phase 3: Verify

Never trust that a session did the right thing.

1. **Read the result:**
   ```bash
   probe result <id>
   ```

2. **Run tests** (spawn a verification session if needed):
   ```bash
   probe new -p "Run the full test suite and report failures" --cwd ./project --auto-approve
   ```

3. **Diff changes:**
   ```bash
   probe new -p "Run git diff and summarize all changes" --cwd ./project --auto-approve
   ```

4. **Fix issues** (send follow-up or new session):
   ```bash
   probe send <id> -p "Tests in test_auth.py failing with TimeoutError. Fix the lock."
   ```

Only move on when verification passes. Otherwise loop: re-plan → re-execute → re-verify.

## Using Claude Code Features

When building a project through probe, set up the target project to leverage Claude Code properly. This makes every session spawned into that project smarter and more consistent.

### CLAUDE.md — Project Instructions

Create a `CLAUDE.md` in the project root with non-obvious rules only. Keep it lean — Claude already knows how to code. Focus on:

- Build/test/lint commands specific to the project
- Architecture decisions that aren't obvious from the code
- Naming conventions that deviate from defaults
- Environment quirks (e.g., "use `py` not `python`")

Don't repeat what's in README or standard docs. Every line costs context window.

### Skills (.claude/skills/)

This is the most important `.claude` subfolder. Store reusable skill packs here and load them into sessions so Claude Code has domain-specific workflows, guardrails, and prompt templates for the project.

You can download preloaded skills from `https://context7.com/skills`.

### Slash Commands (.claude/commands/)

Create reusable workflows as `.md` files in `.claude/commands/`:

```
.claude/commands/
  test.md          # "Run tests and report failures"
  deploy.md        # "Build, lint, test, then deploy to staging"
  review.md        # "Review staged changes for bugs and style"
```

Each file is a prompt template. Users invoke them with `/project:test` in Claude Code. When probe spawns a session into this project, these commands are available.

### Subagents (.claude/agents/)

Define specialized agents in `.claude/agents/` for delegation:

- A **code-reviewer** agent with read-only tools (`Read`, `Glob`, `Grep`)
- A **test-runner** agent that only runs tests
- A **doc-writer** agent for documentation tasks

Agents get their own tool permissions and can be spawned via `Task` tool inside sessions.

### Settings (.claude/settings.json)

Project-level settings apply to every session spawned in that directory:

- **Permissions**: pre-approve safe tools, deny dangerous ones
- **Hooks**: `PreToolUse` to block dangerous patterns, `Stop` to enforce verification
- **Model defaults**: set default model and effort level

### Session Budgets

Use probe flags and Claude Code flags together for cost control:

```bash
# Probe-level: cap turns and let probe enforce
probe new -p "..." --auto-approve --max-turns 10

# Claude Code-level: pass through to the subprocess
probe new -p "..." --auto-approve -- --max-budget-usd 2.00
```

See [references/claude-code-features.md](references/claude-code-features.md) for concrete examples of each pattern.

## Dalton Adapter

Bridges Dalton markdown-based task management with Probe sessions. The manager agent initializes a task list, adds tasks, then hands off execution to probe sessions — no need to hold plans in context across conversations.

### Setup

```bash
# Initialize .dalton/ in a project
probe dalton init --cwd ./project --phases 2

# Add tasks
probe dalton add --phase 1 --title "Set up database schema" --priority high --effort medium \
  --description "Create PostgreSQL schema for users and sessions" \
  --criteria "migrations run cleanly,schema matches ERD"
probe dalton add --phase 1 --title "Add auth endpoints" --priority high --deps "p1-1" \
  --criteria "login returns JWT,refresh token works"
probe dalton add --phase 2 --title "Build dashboard UI" --priority medium --deps "p1-2"
```

This creates:
```
.dalton/
  state.json              # tracks current phase, completed tasks, in-progress
  probe-mapping.json      # tracks task → probe session links
  phases/
    phase_1.md            # task definitions in structured markdown
    phase_2.md
```

### Workflow

1. **Init**: `probe dalton init --cwd ./project` scaffolds `.dalton/`.
2. **Add tasks**: `probe dalton add --phase N --title "..."` appends tasks (auto-assigns sequential IDs like `p1-1`, `p1-2`).
3. **Execute**: `probe dalton work --cwd ./project --auto-approve` picks the next pending task (respects dependency order and priority), spawns a probe session for it.
4. **Monitor**: `probe dalton status --cwd ./project` shows phase progress and linked session status.
5. **Check completion**: `probe dalton check --cwd ./project` evaluates the done gate. If passed, marks the task completed across all state files.
6. **Repeat**: Loop steps 3-5 until all tasks in the phase are complete.

Deduplication is built in — if a task already has an active session, `dalton work` returns the existing session ID instead of spawning a duplicate.

## References

Read these as needed — they're not loaded by default:

- [cli-reference.md](references/cli-reference.md) — Full flag tables, HTTP API endpoints, status fields, events
- [claude-code-features.md](references/claude-code-features.md) — Examples of CLAUDE.md, slash commands, agents, hooks, settings
- [orchestration-patterns.md](references/orchestration-patterns.md) — Parallel sessions, resume patterns, cost tracking, failure escalation
- [setup.md](references/setup.md) — Installation, requirements, server configuration


