# Production Readiness — Incremental PRs

## PR Order
1. **Lifecycle + Guardrails** (items 1 + 6) ← current
2. Permissions + Approval UX (items 3 + 4)
3. Observability + Artifacts (items 2 + 7)
4. Recovery + Test harness (items 5 + 8) — stretch

---

## PR 1: Deterministic Lifecycle + Operational Controls

### 1A. Deterministic session lifecycle

**Problem:** Sessions accumulate in activeSessions Map forever. No auto-cleanup. idle sessions never transition to done unless explicitly killed.

**Changes in `server.ts`:**

- [ ] Add `idleTimeoutMs` config (default 300s) — session auto-transitions idle→done after no new prompt
- [ ] Add session GC: periodic sweep (every 60s) removes done/error sessions from activeSessions Map after `gcDelayMs` (default 60s)
- [ ] On child process exit: if status is running/idle → set done (already done) + emit `session_complete`
- [ ] On WS close: if status is not error → set done (already done)
- [ ] Ensure terminal states (done/error) are truly terminal — no transitions back

**Changes in `watchdog.ts`:**
- [ ] Add `idleTimeout` timer alongside existing timers
- [ ] `trackIdle(sessionId)` — called when session enters idle, starts idle timer
- [ ] Fire `idle_timeout` reason when idle timer expires

**Bug fix in `state.ts`:**
- [ ] Fix `outputTokens` accumulation logic (line 63) — currently uses broken Math.max || addition

### 1B. Operational controls

**Changes — new `src/lib/limits.ts`:**
- [ ] `SessionLimits` interface: `{ maxCostUsd, maxTurns, maxDurationMs, maxConcurrentSessions }`
- [ ] `checkLimits(session, limits)` → returns `{ exceeded: boolean, reason: string }`
- [ ] Checked on every `usage` event and `session_end` event

**Changes in `server.ts`:**
- [ ] Accept `limits` in `CreateSessionOpts` and `createServer()` opts (global defaults)
- [ ] Per-session limits override global defaults
- [ ] On limit exceeded: set status=error, errorCode='limit_exceeded', kill process
- [ ] Max concurrent sessions check in `createSession()` — reject with 429 if at limit

**Changes in `probe.ts` (CLI):**
- [ ] `serve` accepts `--max-cost`, `--max-turns`, `--max-duration`, `--max-sessions`
- [ ] `new` accepts `--max-cost`, `--max-turns` per-session

**Changes — circuit breaker (lightweight):**
- [ ] Track consecutive spawn failures in server state
- [ ] After N consecutive failures (default 3), reject new sessions for cooldown period (30s)
- [ ] Reset counter on successful session start (first event received)

### API additions
- `GET /api/sessions/:id/status` — add `limits` and `limitsExceeded` fields
- `GET /api/diagnostics` — add `circuitBreaker` status, `globalLimits`

### Unresolved questions
- Should idle timeout be configurable per-session or only global? → **Global only for now, simpler**
- Should cost limits include child session costs? → **No, not until PR 3 adds parent/child tracking**
