import { UsageStats } from './state';

export interface SessionLimits {
  maxCostUsd: number;       // 0 = unlimited
  maxTurns: number;         // 0 = unlimited
  maxDurationMs: number;    // 0 = unlimited
}

export interface GlobalLimits extends SessionLimits {
  maxConcurrentSessions: number; // 0 = unlimited
}

export interface LimitCheckResult {
  exceeded: boolean;
  reason: string | null;
  code: string | null;
}

const NO_LIMIT: LimitCheckResult = { exceeded: false, reason: null, code: null };

export function checkSessionLimits(
  usage: UsageStats,
  turns: number,
  startTime: number,
  limits: SessionLimits,
): LimitCheckResult {
  if (limits.maxCostUsd > 0 && usage.costUsd > limits.maxCostUsd) {
    return {
      exceeded: true,
      reason: `Cost $${usage.costUsd.toFixed(4)} exceeds limit $${limits.maxCostUsd.toFixed(4)}`,
      code: 'cost_limit',
    };
  }
  if (limits.maxTurns > 0 && turns >= limits.maxTurns) {
    return {
      exceeded: true,
      reason: `Turn count ${turns} reached limit of ${limits.maxTurns}`,
      code: 'turn_limit',
    };
  }
  if (limits.maxDurationMs > 0) {
    const elapsed = Date.now() - startTime;
    if (elapsed > limits.maxDurationMs) {
      const mins = Math.round(limits.maxDurationMs / 60_000);
      return {
        exceeded: true,
        reason: `Session duration exceeded ${mins}m limit`,
        code: 'duration_limit',
      };
    }
  }
  return NO_LIMIT;
}

export function checkConcurrency(activeCount: number, maxConcurrent: number): LimitCheckResult {
  if (maxConcurrent > 0 && activeCount >= maxConcurrent) {
    return {
      exceeded: true,
      reason: `${activeCount} active sessions, limit is ${maxConcurrent}`,
      code: 'concurrency_limit',
    };
  }
  return NO_LIMIT;
}

/**
 * Circuit breaker: tracks consecutive spawn failures.
 * After `threshold` consecutive failures, rejects new sessions for `cooldownMs`.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  threshold: number;
  cooldownMs: number;

  constructor(threshold = 3, cooldownMs = 30_000) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold && !this.openedAt) {
      this.openedAt = Date.now();
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  isOpen(): boolean {
    if (!this.openedAt) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) {
      // Cooldown expired, allow one attempt (half-open)
      this.openedAt = null;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  getStatus(): { state: 'closed' | 'open'; failures: number; cooldownRemainingMs: number | null } {
    if (!this.openedAt) {
      return { state: 'closed', failures: this.consecutiveFailures, cooldownRemainingMs: null };
    }
    const remaining = this.cooldownMs - (Date.now() - this.openedAt);
    return {
      state: 'open',
      failures: this.consecutiveFailures,
      cooldownRemainingMs: Math.max(0, remaining),
    };
  }
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  maxCostUsd: 0,
  maxTurns: 0,
  maxDurationMs: 0,
};

export const DEFAULT_GLOBAL_LIMITS: GlobalLimits = {
  ...DEFAULT_SESSION_LIMITS,
  maxConcurrentSessions: 0,
};
