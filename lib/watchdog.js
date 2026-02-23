/**
 * SessionWatchdog — per-session timers that detect stuck sessions and escalate to error.
 *
 * Timers:
 *   startup   — WS must connect within N ms of createSession()
 *   firstEvent — first parsed event must arrive within N ms of WS connect
 *   heartbeat  — subsequent events must keep arriving (resets on every event)
 *   approval   — optional auto-timeout for pending approval (disabled by default)
 */

const DEFAULTS = {
  startupTimeoutMs: 45_000,
  firstEventTimeoutMs: 60_000,
  heartbeatTimeoutMs: 120_000,
  approvalTimeoutMs: 0, // 0 = disabled
};

class SessionWatchdog {
  constructor(opts = {}) {
    this.config = { ...DEFAULTS, ...opts };
    this.timers = new Map(); // sessionId → { startup, firstEvent, heartbeat, approval }
    this.onTimeout = null;   // (sessionId, reason, message) => void
  }

  /** Called when session created (status: starting). Starts startup timer. */
  trackStarting(sessionId) {
    this._clear(sessionId);
    const entry = { startup: null, firstEvent: null, heartbeat: null, approval: null };
    if (this.config.startupTimeoutMs > 0) {
      entry.startup = setTimeout(() => {
        this._fire(sessionId, 'startup_timeout',
          `WebSocket did not connect within ${this.config.startupTimeoutMs / 1000}s`);
      }, this.config.startupTimeoutMs);
    }
    this.timers.set(sessionId, entry);
  }

  /** Called when WS connects (status: running). Clears startup, starts firstEvent. */
  trackRunning(sessionId) {
    const entry = this.timers.get(sessionId);
    if (!entry) return;
    if (entry.startup) { clearTimeout(entry.startup); entry.startup = null; }
    if (this.config.firstEventTimeoutMs > 0 && !entry.firstEvent) {
      entry.firstEvent = setTimeout(() => {
        this._fire(sessionId, 'first_event_timeout',
          `No events received within ${this.config.firstEventTimeoutMs / 1000}s of connect`);
      }, this.config.firstEventTimeoutMs);
    }
  }

  /** Called on every ingested event. Resets heartbeat, clears firstEvent. */
  trackActivity(sessionId) {
    const entry = this.timers.get(sessionId);
    if (!entry) return;
    if (entry.firstEvent) { clearTimeout(entry.firstEvent); entry.firstEvent = null; }
    if (entry.heartbeat) clearTimeout(entry.heartbeat);
    if (this.config.heartbeatTimeoutMs > 0) {
      entry.heartbeat = setTimeout(() => {
        this._fire(sessionId, 'heartbeat_timeout',
          `No activity for ${this.config.heartbeatTimeoutMs / 1000}s`);
      }, this.config.heartbeatTimeoutMs);
    }
  }

  /** Called when session enters waiting_approval. Pauses heartbeat, optionally starts approval timer. */
  trackApprovalWaiting(sessionId) {
    const entry = this.timers.get(sessionId);
    if (!entry) return;
    if (entry.heartbeat) { clearTimeout(entry.heartbeat); entry.heartbeat = null; }
    if (this.config.approvalTimeoutMs > 0) {
      entry.approval = setTimeout(() => {
        this._fire(sessionId, 'approval_timeout',
          `Approval not received within ${this.config.approvalTimeoutMs / 1000}s`);
      }, this.config.approvalTimeoutMs);
    }
  }

  /** Called when approval resolved. Clears approval timer, resumes heartbeat. */
  trackApprovalResolved(sessionId) {
    const entry = this.timers.get(sessionId);
    if (!entry) return;
    if (entry.approval) { clearTimeout(entry.approval); entry.approval = null; }
    this.trackActivity(sessionId);
  }

  /** Called when session ends (done/error). Clears all timers. */
  untrack(sessionId) {
    this._clear(sessionId);
  }

  /** Shutdown: clear all timers. */
  destroy() {
    for (const id of this.timers.keys()) this._clear(id);
  }

  _fire(sessionId, reason, message) {
    this._clear(sessionId);
    if (this.onTimeout) this.onTimeout(sessionId, reason, message);
  }

  _clear(sessionId) {
    const entry = this.timers.get(sessionId);
    if (!entry) return;
    if (entry.startup) clearTimeout(entry.startup);
    if (entry.firstEvent) clearTimeout(entry.firstEvent);
    if (entry.heartbeat) clearTimeout(entry.heartbeat);
    if (entry.approval) clearTimeout(entry.approval);
    this.timers.delete(sessionId);
  }
}

module.exports = { SessionWatchdog };
