/**
 * Approval policies: rules that auto-approve tool use based on patterns.
 *
 * Policies match on tool name (glob-like) and optional path patterns.
 * Scoped to session or global, with optional expiration.
 */

export type PolicyScope = 'session' | 'global';

export interface ApprovalPolicy {
  id: string;
  toolPattern: string;             // glob: "Write", "Bash", "*", "Edit"
  pathPattern?: string;            // optional path glob: "/workspace/**", "/tmp/*"
  scope: PolicyScope;
  sessionId?: string;              // only for scope=session
  createdAt: number;
  expiresAt?: number;              // 0 or undefined = no expiry
}

export interface PolicyMatch {
  matched: boolean;
  policy: ApprovalPolicy | null;
}

let policyCounter = 0;

export class PolicyEngine {
  policies: ApprovalPolicy[] = [];

  addPolicy(opts: Omit<ApprovalPolicy, 'id' | 'createdAt'>): ApprovalPolicy {
    const policy: ApprovalPolicy = {
      id: `pol_${Date.now()}_${++policyCounter}`,
      createdAt: Date.now(),
      ...opts,
    };
    this.policies.push(policy);
    return policy;
  }

  removePolicy(policyId: string): boolean {
    const idx = this.policies.findIndex(p => p.id === policyId);
    if (idx === -1) return false;
    this.policies.splice(idx, 1);
    return true;
  }

  /** Remove all policies scoped to a specific session. */
  clearSessionPolicies(sessionId: string): number {
    const before = this.policies.length;
    this.policies = this.policies.filter(
      p => !(p.scope === 'session' && p.sessionId === sessionId)
    );
    return before - this.policies.length;
  }

  /** Check if a tool use matches any active policy. */
  match(toolName: string, input: unknown, sessionId?: string): PolicyMatch {
    const now = Date.now();
    for (const policy of this.policies) {
      // Check expiry
      if (policy.expiresAt && policy.expiresAt < now) continue;

      // Check session scope
      if (policy.scope === 'session' && policy.sessionId !== sessionId) continue;

      // Check tool pattern
      if (!matchGlob(policy.toolPattern, toolName)) continue;

      // Check path pattern (if specified)
      if (policy.pathPattern && input) {
        const paths = extractPaths(input);
        if (paths.length > 0 && !paths.some(p => matchGlob(policy.pathPattern!, p))) {
          continue;
        }
      }

      return { matched: true, policy };
    }
    return { matched: false, policy: null };
  }

  /** List all active (non-expired) policies. */
  listActive(sessionId?: string): ApprovalPolicy[] {
    const now = Date.now();
    return this.policies.filter(p => {
      if (p.expiresAt && p.expiresAt < now) return false;
      if (sessionId && p.scope === 'session' && p.sessionId !== sessionId) return false;
      return true;
    });
  }

  /** Remove expired policies. */
  gc(): number {
    const now = Date.now();
    const before = this.policies.length;
    this.policies = this.policies.filter(p => !p.expiresAt || p.expiresAt >= now);
    return before - this.policies.length;
  }
}

/**
 * Simple glob matching: supports * (any chars) and exact match.
 * Case-insensitive for tool names.
 */
function matchGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  // Convert glob to regex: escape special chars, replace * with .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(`^${escaped}$`, 'i');
  return re.test(value);
}

/**
 * Extract file paths from tool input for path-pattern matching.
 * Handles common Claude tool schemas (Write, Edit, Read, Bash, etc.)
 */
function extractPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const obj = input as Record<string, unknown>;
  const paths: string[] = [];

  // Common path fields in Claude tool inputs
  for (const key of ['file_path', 'path', 'command', 'filePath', 'directory']) {
    if (typeof obj[key] === 'string') {
      paths.push(obj[key] as string);
    }
  }

  return paths;
}
