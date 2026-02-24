export interface WatchdogConfig {
  startupTimeoutMs: number;
  firstEventTimeoutMs: number;
  heartbeatTimeoutMs: number;
  approvalTimeoutMs: number;
  idleTimeoutMs: number;
}

interface TimerEntry {
  startup: ReturnType<typeof setTimeout> | null;
  firstEvent: ReturnType<typeof setTimeout> | null;
  heartbeat: ReturnType<typeof setTimeout> | null;
  approval: ReturnType<typeof setTimeout> | null;
  idle: ReturnType<typeof setTimeout> | null;
}

export type TimeoutCallback = (sessionId: string, reason: string, message: string) => void;

const DEFAULTS: WatchdogConfig = {
  startupTimeoutMs: 90_000,
  firstEventTimeoutMs: 60_000,
  heartbeatTimeoutMs: 120_000,
  approvalTimeoutMs: 0, // 0 = disabled
  idleTimeoutMs: 300_000, // 5 minutes idle → done
};

export class SessionWatchdog {
  config: WatchdogConfig;
  timers: Map<string, TimerEntry> = new Map();
  onTimeout: TimeoutCallback | null = null;
  onIdleExpired: ((sessionId: string) => void) | null = null;

  constructor(opts: Partial<WatchdogConfig> = {}) {
    this.config = { ...DEFAULTS, ...opts };
  }

  /** Called when session created (status: starting). Starts startup timer. */
  trackStarting(sessionId: string): void {
    this._clear(sessionId);
    const entry: TimerEntry = { startup: null, firstEvent: null, heartbeat: null, approval: null, idle: null };
    if (this.config.startupTimeoutMs > 0) {
      entry.startup = setTimeout(() => {
        this._fire(sessionId, 'startup_timeout',
          `WebSocket did not connect within ${this.config.startupTimeoutMs / 1000}s`);
      }, this.config.startupTimeoutMs);
    }
    this.timers.set(sessionId, entry);
  }

  /** Called when WS connects (status: running). Clears startup, starts firstEvent. */
  trackRunning(sessionId: string): void {
    const entry = this.timers.get(sessionId);
    if (!entry) return;
    if (entry.startup) { clearTimeout(entry.startup); entry.startup = null; }
    if (entry.idle) { clearTimeout(entry.idle); entry.idle = null; }
    if (this.config.firstEventTimeoutMs > 0 && !entry.firstEvent) {
      entry.firstEvent = setTimeout(() => {
        this._fire(sessionId, 'first_event_timeout',
          `No events received within ${this.config.firstEventTimeoutMs / 1000}s of connect`);
      }, this.config.firstEventTimeoutMs);
    }
  }

  /** Called on every ingested event. Resets heartbeat, clears firstEvent. */
  trackActivity(sessionId: string): void {
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
  trackApprovalWaiting(sessionId: string): void {
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
  trackApprovalResolved(sessionId: string): void {
    const entry = this.timers.get(sessionId);
    if (!entry) return;
    if (entry.approval) { clearTimeout(entry.approval); entry.approval = null; }
    this.trackActivity(sessionId);
  }

  /** Called when session enters idle (turn complete, waiting for next prompt). Starts idle timer. */
  trackIdle(sessionId: string): void {
    const entry = this.timers.get(sessionId);
    if (!entry) return;
    // Clear running-phase timers
    if (entry.heartbeat) { clearTimeout(entry.heartbeat); entry.heartbeat = null; }
    if (entry.firstEvent) { clearTimeout(entry.firstEvent); entry.firstEvent = null; }
    // Start idle timer
    if (entry.idle) clearTimeout(entry.idle);
    if (this.config.idleTimeoutMs > 0) {
      entry.idle = setTimeout(() => {
        if (this.onIdleExpired) this.onIdleExpired(sessionId);
      }, this.config.idleTimeoutMs);
    }
  }

  /** Called when session ends (done/error). Clears all timers. */
  untrack(sessionId: string): void {
    this._clear(sessionId);
  }

  /** Shutdown: clear all timers. */
  destroy(): void {
    for (const id of this.timers.keys()) this._clear(id);
  }

  private _fire(sessionId: string, reason: string, message: string): void {
    this._clear(sessionId);
    if (this.onTimeout) this.onTimeout(sessionId, reason, message);
  }

  private _clear(sessionId: string): void {
    const entry = this.timers.get(sessionId);
    if (!entry) return;
    if (entry.startup) clearTimeout(entry.startup);
    if (entry.firstEvent) clearTimeout(entry.firstEvent);
    if (entry.heartbeat) clearTimeout(entry.heartbeat);
    if (entry.approval) clearTimeout(entry.approval);
    if (entry.idle) clearTimeout(entry.idle);
    this.timers.delete(sessionId);
  }
}
