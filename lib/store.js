const fs = require('node:fs');
const path = require('node:path');

class SessionStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
  }

  /**
   * Append an event to a session's .jsonl file.
   */
  appendEvent(sessionId, event) {
    const filePath = this._sessionPath(sessionId);
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
  }

  /**
   * Load all events for a session.
   */
  loadSession(sessionId) {
    const filePath = this._sessionPath(sessionId);
    if (!fs.existsSync(filePath)) return null;

    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return events;
  }

  /**
   * Check if a session exists on disk.
   */
  hasSession(sessionId) {
    return fs.existsSync(this._sessionPath(sessionId));
  }

  /**
   * List all sessions with metadata (parsed from first/last events).
   */
  listSessions() {
    const files = fs.readdirSync(this.dataDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
      .reverse(); // newest first

    const sessions = [];
    for (const file of files) {
      const filePath = path.join(this.dataDir, file);
      const sessionId = file.replace('.jsonl', '');

      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        if (lines.length === 0) continue;

        let model = null;
        let claudeSessionId = null;
        let startTime = null;
        let costUsd = null;
        let durationMs = null;
        let numTurns = null;
        let isError = false;
        let eventCount = lines.length;
        let toolCalls = 0;
        let ended = false;

        // Scan events for metadata
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            if (!startTime && evt.ts) startTime = evt.ts;

            if (evt.kind === 'init') {
              model = evt.model;
              claudeSessionId = evt.sessionId;
            }
            if (evt.kind === 'tool_call' || (evt.kind === 'block_start' && (evt.blockType === 'tool_use' || evt.blockType === 'server_tool_use'))) {
              toolCalls++;
            }
            if (evt.kind === 'session_end') {
              costUsd = evt.costUsd;
              durationMs = evt.durationMs;
              numTurns = evt.numTurns;
              isError = evt.isError || false;
              ended = true;
            }
            if (evt.kind === 'session_complete') {
              ended = true;
              if (evt.durationMs) durationMs = evt.durationMs;
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
        });
      } catch {
        // skip unreadable files
      }
    }

    return sessions;
  }

  /**
   * Delete a session's log file.
   */
  deleteSession(sessionId) {
    const filePath = this._sessionPath(sessionId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  /**
   * Generate a unique session filename.
   * Uses timestamp + random suffix to avoid collisions.
   */
  generateSessionId() {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const rand = Math.random().toString(36).slice(2, 6);
    return `${ts}_${rand}`;
  }

  _sessionPath(sessionId) {
    // Sanitize to prevent directory traversal
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dataDir, `${safe}.jsonl`);
  }
}

module.exports = { SessionStore };
