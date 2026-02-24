import fs from 'node:fs';
import path from 'node:path';
import { ProbeEvent } from './state';

export interface SessionSummary {
  id: string;
  claudeSessionId: string | null;
  model: string | null;
  startTime: number | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  isError: boolean;
  eventCount: number;
  toolCalls: number;
  ended: boolean;
  fileSize: number;
  preview: string | null;
  cwd: string | null;
  // Merged from active sessions at runtime
  status?: string;
  pendingApproval?: unknown;
}

export class SessionStore {
  dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
  }

  /** Append an event to a session's .jsonl file. */
  appendEvent(sessionId: string, event: ProbeEvent): void {
    const filePath = this._sessionPath(sessionId);
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
  }

  /** Load all events for a session. */
  loadSession(sessionId: string): ProbeEvent[] | null {
    const filePath = this._sessionPath(sessionId);
    if (!fs.existsSync(filePath)) return null;

    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const events: ProbeEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return events;
  }

  /** Check if a session exists on disk. */
  hasSession(sessionId: string): boolean {
    return fs.existsSync(this._sessionPath(sessionId));
  }

  /** List all sessions with metadata (parsed from first/last events). */
  listSessions(): SessionSummary[] {
    const files = fs.readdirSync(this.dataDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse(); // newest first

    const sessions: SessionSummary[] = [];
    for (const file of files) {
      const filePath = path.join(this.dataDir, file);
      const sessionId = file.replace('.jsonl', '');

      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        if (lines.length === 0) continue;

        let model: string | null = null;
        let claudeSessionId: string | null = null;
        let startTime: number | null = null;
        let costUsd: number | null = null;
        let durationMs: number | null = null;
        let numTurns: number | null = null;
        let isError = false;
        const eventCount = lines.length;
        let toolCalls = 0;
        let ended = false;
        let preview: string | null = null;
        let cwd: string | null = null;

        // Scan events for metadata
        for (const line of lines) {
          try {
            const evt = JSON.parse(line) as ProbeEvent;
            if (!startTime && evt.ts) startTime = evt.ts;

            if (evt.kind === 'session_start') {
              if (evt.cwd) cwd = evt.cwd as string;
              if (evt.model) model = evt.model as string;
            }
            if (evt.kind === 'init') {
              model = evt.model as string;
              claudeSessionId = evt.sessionId as string;
            }
            if (evt.kind === 'tool_call' || (evt.kind === 'block_start' && (evt.blockType === 'tool_use' || evt.blockType === 'server_tool_use'))) {
              toolCalls++;
            }
            if (!preview && evt.kind === 'user_message' && evt.text) {
              preview = (evt.text as string).slice(0, 150).trim();
            }
            if (!preview && (evt.kind === 'text' || evt.kind === 'text_delta') && evt.text) {
              preview = (evt.text as string).slice(0, 150).trim();
            }
            if (evt.kind === 'session_end') {
              costUsd = evt.costUsd as number;
              durationMs = evt.durationMs as number;
              numTurns = evt.numTurns as number;
              isError = (evt.isError as boolean) || false;
              ended = true;
              const trimmedResult = ((evt.result as string) || '').slice(0, 150).trim();
              if (trimmedResult) {
                preview = trimmedResult;
              }
            }
            if (evt.kind === 'session_complete') {
              ended = true;
              if (evt.durationMs) durationMs = evt.durationMs as number;
            }
          } catch {
            // skip
          }
        }

        sessions.push({
          id: sessionId,
          claudeSessionId,
          model,
          startTime,
          costUsd,
          durationMs,
          numTurns,
          isError,
          eventCount,
          toolCalls,
          ended,
          fileSize: stat.size,
          preview,
          cwd,
        });
      } catch {
        // skip unreadable files
      }
    }

    return sessions;
  }

  /** Delete a session's log file. */
  deleteSession(sessionId: string): boolean {
    const filePath = this._sessionPath(sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  /** Generate a unique session filename. */
  generateSessionId(): string {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const rand = Math.random().toString(36).slice(2, 6);
    return `${ts}_${rand}`;
  }

  private _sessionPath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dataDir, `${safe}.jsonl`);
  }
}
