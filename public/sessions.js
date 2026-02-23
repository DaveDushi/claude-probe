(() => {
  // --- DOM refs ---
  const sessionsList = document.getElementById('sessions-list');
  const sessionsCount = document.getElementById('sessions-count');
  const emptyState = document.getElementById('empty-state');
  const noMatchState = document.getElementById('no-match-state');
  const refreshBtn = document.getElementById('refresh-btn');
  const searchInput = document.getElementById('search-input');
  const sortSelect = document.getElementById('sort-select');
  const filterChips = document.querySelectorAll('.filter-chip-btn');
  const deleteDialog = document.getElementById('delete-dialog');
  const deleteCancel = document.getElementById('delete-cancel');
  const deleteConfirm = document.getElementById('delete-confirm');

  // --- State ---
  let allSessions = [];
  let activeFilter = 'all';
  let pendingDeleteId = null;

  // --- Formatting helpers ---
  function relativeTime(ts) {
    if (!ts) return '--';
    const now = Date.now();
    const diff = now - new Date(ts).getTime();
    if (diff < 0) return 'just now';
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function fullTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString();
  }

  function formatDuration(ms) {
    if (!ms) return '--';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    if (mins < 60) return `${mins}m ${secs}s`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  function formatCost(usd) {
    if (!usd) return '--';
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
  }

  function formatSize(bytes) {
    if (!bytes) return '--';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- Date grouping ---
  function dateKey(ts) {
    if (!ts) return 'Unknown';
    const d = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const sessionDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

    if (sessionDate.getTime() === today.getTime()) return 'Today';
    if (sessionDate.getTime() === yesterday.getTime()) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // --- Filtering ---
  function matchesFilter(s) {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'active') return !s.ended;
    if (activeFilter === 'completed') return s.ended && !s.isError;
    if (activeFilter === 'error') return s.isError;
    return true;
  }

  function matchesSearch(s, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      (s.model || '').toLowerCase().includes(q) ||
      (s.claudeSessionId || '').toLowerCase().includes(q) ||
      (s.id || '').toLowerCase().includes(q) ||
      (s.preview || '').toLowerCase().includes(q)
    );
  }

  // --- Sorting ---
  function sortSessions(sessions) {
    const key = sortSelect.value;
    const copy = [...sessions];
    switch (key) {
      case 'oldest': return copy.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      case 'expensive': return copy.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));
      case 'longest': return copy.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));
      case 'most-tools': return copy.sort((a, b) => (b.toolCalls || 0) - (a.toolCalls || 0));
      default: return copy.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    }
  }

  // --- Session card HTML ---
  function sessionCardHtml(s) {
    const statusClass = s.isError ? 'error-session' : !s.ended ? 'active-session' : '';
    const modelDisplay = escapeHtml(s.model || 'unknown');

    // Model badge color
    let modelClass = 'model-default';
    const m = (s.model || '').toLowerCase();
    if (m.includes('opus')) modelClass = 'model-opus';
    else if (m.includes('sonnet')) modelClass = 'model-sonnet';
    else if (m.includes('haiku')) modelClass = 'model-haiku';

    // Status indicator
    let statusHtml = '';
    if (!s.ended) {
      statusHtml = '<span class="session-live-badge">LIVE</span>';
    } else if (s.isError) {
      statusHtml = '<svg class="session-error-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    }

    // Preview
    const previewHtml = s.preview
      ? `<div class="session-preview">${escapeHtml(s.preview)}</div>`
      : '';

    // Short session ID
    const shortId = (s.claudeSessionId || s.id || '').slice(0, 12);

    return `
      <div class="session-card ${statusClass}" data-id="${escapeHtml(s.id)}">
        <a href="/index.html?session=${encodeURIComponent(s.id)}" class="session-card-link">
          <div class="session-header">
            <span class="session-model ${modelClass}">${modelDisplay}</span>
            ${statusHtml}
            <span class="session-time" title="${escapeHtml(fullTime(s.startTime))}">${relativeTime(s.startTime)}</span>
          </div>
          ${previewHtml}
          <div class="session-stats">
            <span class="session-stat" title="Duration">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              ${formatDuration(s.durationMs)}
            </span>
            <span class="session-stat" title="Cost">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              ${formatCost(s.costUsd)}
            </span>
            <span class="session-stat" title="Turns">${s.numTurns || '--'} turns</span>
            <span class="session-stat" title="Tool calls">${s.toolCalls || '--'} tools</span>
            <span class="session-stat" title="Events">${s.eventCount || '--'} events</span>
            <span class="session-stat dim" title="File size">${formatSize(s.fileSize)}</span>
          </div>
          <div class="session-footer">
            <span class="session-id" title="${escapeHtml(s.claudeSessionId || s.id)}">${escapeHtml(shortId)}</span>
          </div>
        </a>
        <button class="session-delete-btn" data-id="${escapeHtml(s.id)}" title="Delete session">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>`;
  }

  // --- Render ---
  function render() {
    const query = searchInput.value.trim();
    const filtered = allSessions.filter(s => matchesFilter(s) && matchesSearch(s, query));
    const sorted = sortSessions(filtered);

    // Update count
    if (allSessions.length === 0) {
      sessionsCount.textContent = '';
    } else if (filtered.length === allSessions.length) {
      sessionsCount.textContent = `${allSessions.length} session${allSessions.length !== 1 ? 's' : ''}`;
    } else {
      sessionsCount.textContent = `${filtered.length} of ${allSessions.length} sessions`;
    }

    // Show/hide states
    if (allSessions.length === 0) {
      sessionsList.classList.add('hidden');
      noMatchState.classList.add('hidden');
      emptyState.classList.remove('hidden');
      return;
    }
    emptyState.classList.add('hidden');

    if (filtered.length === 0) {
      sessionsList.classList.add('hidden');
      noMatchState.classList.remove('hidden');
      return;
    }
    noMatchState.classList.add('hidden');
    sessionsList.classList.remove('hidden');

    // Group by date (only if sorted by time)
    const sortKey = sortSelect.value;
    const useGroups = sortKey === 'newest' || sortKey === 'oldest';

    if (useGroups) {
      const groups = new Map();
      for (const s of sorted) {
        const key = dateKey(s.startTime);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }

      let html = '';
      for (const [label, sessions] of groups) {
        html += `<div class="date-group-header">${escapeHtml(label)}</div>`;
        html += sessions.map(sessionCardHtml).join('');
      }
      sessionsList.innerHTML = html;
    } else {
      sessionsList.innerHTML = sorted.map(sessionCardHtml).join('');
    }

    // Attach delete handlers
    sessionsList.querySelectorAll('.session-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        pendingDeleteId = btn.dataset.id;
        deleteDialog.classList.remove('hidden');
      });
    });
  }

  // --- Load sessions ---
  let firstLoad = true;
  async function loadSessions() {
    // Only show skeleton on first load to avoid flicker on live updates
    if (firstLoad) {
      sessionsList.classList.remove('hidden');
      emptyState.classList.add('hidden');
      noMatchState.classList.add('hidden');
      sessionsList.innerHTML = Array(3).fill(0).map(() => `
        <div class="session-card skeleton">
          <div class="skeleton-line w60"></div>
          <div class="skeleton-line w90"></div>
          <div class="skeleton-line w40"></div>
        </div>
      `).join('');
    }

    try {
      const res = await fetch('/api/sessions');
      allSessions = await res.json();
      firstLoad = false;
      render();
    } catch (err) {
      if (firstLoad) {
        sessionsList.innerHTML = `<div class="error-msg">Failed to load sessions: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  // --- Delete session ---
  async function deleteSession(id) {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) {
        allSessions = allSessions.filter(s => s.id !== id);
        render();
      } else {
        sessionsList.insertAdjacentHTML('afterbegin',
          `<div class="error-msg" style="padding:10px;margin-bottom:8px">Failed to delete session (${res.status})</div>`);
        setTimeout(() => sessionsList.querySelector('.error-msg')?.remove(), 3000);
      }
    } catch (err) {
      sessionsList.insertAdjacentHTML('afterbegin',
        `<div class="error-msg" style="padding:10px;margin-bottom:8px">Delete failed: ${escapeHtml(err.message)}</div>`);
      setTimeout(() => sessionsList.querySelector('.error-msg')?.remove(), 3000);
    }
  }

  // --- Event listeners ---
  refreshBtn.addEventListener('click', loadSessions);
  searchInput.addEventListener('input', render);
  sortSelect.addEventListener('change', render);

  filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
      filterChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      activeFilter = chip.dataset.filter;
      render();
    });
  });

  deleteCancel.addEventListener('click', () => {
    deleteDialog.classList.add('hidden');
    pendingDeleteId = null;
  });

  deleteConfirm.addEventListener('click', () => {
    if (pendingDeleteId) {
      deleteSession(pendingDeleteId);
      pendingDeleteId = null;
    }
    deleteDialog.classList.add('hidden');
  });

  // Close dialog on overlay click
  deleteDialog.addEventListener('click', (e) => {
    if (e.target === deleteDialog) {
      deleteDialog.classList.add('hidden');
      pendingDeleteId = null;
    }
  });

  // Keyboard: Escape to close dialog
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !deleteDialog.classList.contains('hidden')) {
      deleteDialog.classList.add('hidden');
      pendingDeleteId = null;
    }
  });

  // --- Live updates via WebSocket + polling fallback ---
  let refreshDebounce = null;
  let wsConnected = false;

  function scheduleRefresh(delayMs = 500) {
    if (refreshDebounce) clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(() => {
      refreshDebounce = null;
      loadSessions();
    }, delayMs);
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      wsConnected = true;
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // Refresh on ANY event from the server — new session data is flowing
        if (msg.type === 'event' || msg.type === 'snapshot') {
          scheduleRefresh();
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      wsConnected = false;
      setTimeout(connectWs, 3000);
    };

    ws.onerror = () => ws.close();
  }

  // Polling fallback: check periodically for new sessions
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      loadSessions();
    }, wsConnected ? 30000 : 5000);
  }
  startPolling();

  // --- Init ---
  loadSessions();
  connectWs();
})();
