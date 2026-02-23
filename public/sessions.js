(() => {
  const sessionsList = document.getElementById('sessions-list');
  const sessionsCount = document.getElementById('sessions-count');
  const emptyState = document.getElementById('empty-state');
  const refreshBtn = document.getElementById('refresh-btn');

  function formatTime(ts) {
    if (!ts) return '--';
    const d = new Date(ts);
    return d.toLocaleString();
  }

  function formatDuration(ms) {
    if (!ms) return '--';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  function formatCost(usd) {
    if (!usd) return '--';
    return `$${usd.toFixed(4)}`;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function loadSessions() {
    try {
      const res = await fetch('/api/sessions');
      const sessions = await res.json();

      if (sessions.length === 0) {
        sessionsList.classList.add('hidden');
        emptyState.classList.remove('hidden');
        sessionsCount.textContent = 'No sessions';
        return;
      }

      sessionsList.classList.remove('hidden');
      emptyState.classList.add('hidden');
      sessionsCount.textContent = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;

      sessionsList.innerHTML = sessions.map(s => `
        <a href="/index.html?session=${encodeURIComponent(s.id)}" class="session-card ${s.isError ? 'error-session' : ''} ${!s.ended ? 'active-session' : ''}">
          <div class="session-header">
            <span class="session-model">${escapeHtml(s.model || 'unknown')}</span>
            <span class="session-time">${formatTime(s.startTime)}</span>
            ${!s.ended ? '<span class="session-live-badge">LIVE</span>' : ''}
          </div>
          <div class="session-meta">
            <span class="session-stat" title="Events">${s.eventCount} events</span>
            <span class="session-stat" title="Tool calls">${s.toolCalls} tools</span>
            <span class="session-stat" title="Turns">${s.numTurns || '--'} turns</span>
            <span class="session-stat" title="Duration">${formatDuration(s.durationMs)}</span>
            <span class="session-stat" title="Cost">${formatCost(s.costUsd)}</span>
            <span class="session-stat dim" title="File size">${formatSize(s.fileSize)}</span>
          </div>
          <div class="session-id">${escapeHtml(s.claudeSessionId || s.id)}</div>
        </a>
      `).join('');

    } catch (err) {
      sessionsList.innerHTML = `<div class="error-msg">Failed to load sessions: ${escapeHtml(err.message)}</div>`;
    }
  }

  refreshBtn.addEventListener('click', loadSessions);
  loadSessions();
})();
