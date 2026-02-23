(() => {
  // --- State ---
  const events = [];
  const toolCounts = {};
  let usage = { inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, costUsd: 0 };
  let sessionEnded = false;
  let autoScroll = true;

  // Active streaming blocks: blockIndex -> { element, type, content }
  const activeBlocks = {};
  // Map tool IDs to their card elements for pairing call+result
  const toolCardMap = {};

  // --- DOM refs ---
  const timeline = document.getElementById('timeline');
  const timelineContainer = document.getElementById('timeline-container');
  const jumpBtn = document.getElementById('jump-bottom');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const modelBadge = document.getElementById('model-badge');
  const sessionBadge = document.getElementById('session-badge');
  const statInput = document.getElementById('stat-input');
  const statOutput = document.getElementById('stat-output');
  const statCacheCreate = document.getElementById('stat-cache-create');
  const statCacheRead = document.getElementById('stat-cache-read');
  const statCost = document.getElementById('stat-cost');
  const statDuration = document.getElementById('stat-duration');
  const statTurns = document.getElementById('stat-turns');
  const toolsList = document.getElementById('tools-list');

  // Filters
  const filters = {
    text: document.getElementById('filter-text'),
    tool: document.getElementById('filter-tool'),
    thinking: document.getElementById('filter-thinking'),
    result: document.getElementById('filter-result'),
    system: document.getElementById('filter-system'),
  };

  // --- Formatting helpers ---
  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatNumber(n) {
    if (n === undefined || n === null) return '0';
    return n.toLocaleString();
  }

  function formatDuration(ms) {
    if (!ms) return '--';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function truncateText(str, maxLen = 200) {
    if (!str || str.length <= maxLen) return str;
    return str.slice(0, maxLen) + '...';
  }

  function formatJson(obj) {
    try {
      if (typeof obj === 'string') obj = JSON.parse(obj);
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }

  // --- Update stats ---
  function updateStats() {
    statInput.textContent = formatNumber(usage.inputTokens);
    statOutput.textContent = formatNumber(usage.outputTokens);
    statCacheCreate.textContent = formatNumber(usage.cacheCreation);
    statCacheRead.textContent = formatNumber(usage.cacheRead);
    statCost.textContent = usage.costUsd ? `$${usage.costUsd.toFixed(4)}` : '$0.00';
  }

  function updateToolsList() {
    if (Object.keys(toolCounts).length === 0) {
      toolsList.innerHTML = '<span class="dim">None yet</span>';
      return;
    }
    toolsList.innerHTML = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `<span class="tool-tag">${escapeHtml(name)}<span class="tool-count">×${count}</span></span>`)
      .join('');
  }

  // --- Scroll management ---
  timelineContainer.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = timelineContainer;
    autoScroll = scrollHeight - scrollTop - clientHeight < 60;
    jumpBtn.classList.toggle('hidden', autoScroll);
  });

  jumpBtn.addEventListener('click', () => {
    autoScroll = true;
    timelineContainer.scrollTop = timelineContainer.scrollHeight;
    jumpBtn.classList.add('hidden');
  });

  function scrollToBottom() {
    if (autoScroll) {
      requestAnimationFrame(() => {
        timelineContainer.scrollTop = timelineContainer.scrollHeight;
      });
    }
  }

  // --- Filter visibility ---
  function getEventCategory(kind) {
    if (['text', 'text_delta'].includes(kind)) return 'text';
    if (['tool_call', 'tool_input_delta', 'block_start'].includes(kind)) return 'tool';
    if (['thinking', 'thinking_delta'].includes(kind)) return 'thinking';
    if (['tool_result'].includes(kind)) return 'result';
    return 'system';
  }

  function applyFilters() {
    document.querySelectorAll('.event-card').forEach(card => {
      const cat = card.dataset.category;
      if (cat && filters[cat]) {
        card.style.display = filters[cat].checked ? '' : 'none';
      }
    });
  }

  Object.values(filters).forEach(cb => cb.addEventListener('change', applyFilters));

  // --- Render events ---
  function createCard(kind, timestamp, opts = {}) {
    const card = document.createElement('div');
    const categoryMap = {
      tool_call: 'tool', tool_input_delta: 'tool',
      text: 'text', text_delta: 'text',
      thinking: 'thinking', thinking_delta: 'thinking',
      tool_result: 'result',
      block_start: opts.blockType === 'thinking' ? 'thinking' : opts.blockType === 'tool_use' || opts.blockType === 'server_tool_use' ? 'tool' : 'text',
    };
    const cat = categoryMap[kind] || 'system';
    card.className = `event-card ${cat}-event`;
    card.dataset.category = cat;

    // Check filter visibility
    if (filters[cat] && !filters[cat].checked) {
      card.style.display = 'none';
    }

    const header = document.createElement('div');
    header.className = 'event-header';

    const ts = document.createElement('span');
    ts.className = 'event-timestamp';
    ts.textContent = formatTime(timestamp);
    header.appendChild(ts);

    if (opts.badge) {
      const badge = document.createElement('span');
      badge.className = `event-badge ${opts.badgeClass || ''}`;
      badge.textContent = opts.badge;
      header.appendChild(badge);
    }

    if (opts.title) {
      const title = document.createElement('span');
      title.className = 'event-title';
      title.textContent = opts.title;
      header.appendChild(title);
    }

    if (opts.collapsible) {
      const icon = document.createElement('span');
      icon.className = 'collapse-icon';
      icon.textContent = '\u25BC';
      header.appendChild(icon);
      header.classList.add('collapsible-header');
    }

    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'event-body';
    card.appendChild(body);

    if (opts.collapsible) {
      let collapsed = false;
      header.addEventListener('click', () => {
        collapsed = !collapsed;
        body.style.display = collapsed ? 'none' : '';
        header.querySelector('.collapse-icon').classList.toggle('collapsed', collapsed);
      });
    }

    return { card, body, header };
  }

  function addCodeBlock(parent, text, opts = {}) {
    const block = document.createElement('pre');
    block.className = 'code-block';
    if (opts.isError) block.classList.add('error-content');
    block.textContent = text;

    const lines = text.split('\n').length;
    if (lines > 15 && !opts.noCollapse) {
      block.classList.add('collapsed');
      parent.appendChild(block);
      const btn = document.createElement('button');
      btn.className = 'expand-btn';
      btn.textContent = `Show all (${lines} lines)`;
      btn.addEventListener('click', () => {
        const isCollapsed = block.classList.contains('collapsed');
        block.classList.toggle('collapsed');
        btn.textContent = isCollapsed ? 'Collapse' : `Show all (${lines} lines)`;
      });
      parent.appendChild(btn);
    } else {
      parent.appendChild(block);
    }

    return block;
  }

  // --- Handle individual event kinds ---
  function handleEvent(event) {
    events.push(event);
    const kind = event.kind;

    // Update usage stats
    if (kind === 'usage') {
      if (event.inputTokens) usage.inputTokens += event.inputTokens;
      if (event.outputTokens) usage.outputTokens += event.outputTokens;
      if (event.cacheCreation) usage.cacheCreation += event.cacheCreation;
      if (event.cacheRead) usage.cacheRead += event.cacheRead;
      updateStats();
      return; // Don't render usage events as cards
    }

    if (kind === 'init') {
      modelBadge.textContent = event.model || '';
      sessionBadge.textContent = event.sessionId ? event.sessionId.slice(0, 12) : '';
      statusDot.className = 'status-dot streaming';
      statusText.textContent = 'Streaming';

      const { card, body } = createCard(kind, event.ts, {
        badge: 'SYS', badgeClass: 'system',
        title: 'Session initialized',
      });
      if (event.tools && event.tools.length > 0) {
        const label = document.createElement('div');
        label.className = 'section-label';
        label.textContent = `${event.tools.length} tools available`;
        body.appendChild(label);
        const toolsStr = event.tools.map(t => typeof t === 'string' ? t : t.name || JSON.stringify(t)).join(', ');
        addCodeBlock(body, toolsStr);
      }
      timeline.appendChild(card);
      scrollToBottom();
      return;
    }

    if (kind === 'stream_message_start') {
      if (event.model) modelBadge.textContent = event.model;
      statusDot.className = 'status-dot streaming';
      statusText.textContent = 'Streaming';
      return; // Don't render as a card
    }

    if (kind === 'stream_message_delta' || kind === 'stream_message_stop' || kind === 'signature_delta') {
      return; // Internal events, skip rendering
    }

    // --- Block-based streaming events ---
    if (kind === 'block_start') {
      if (event.blockType === 'thinking') {
        const { card, body } = createCard(kind, event.ts, {
          badge: 'THINK', badgeClass: 'think',
          title: 'Thinking...',
          collapsible: true,
        });
        const content = document.createElement('div');
        content.className = 'thinking-content streaming-cursor';
        body.appendChild(content);
        activeBlocks[event.blockIndex] = { element: content, card, type: 'thinking', content: '' };
        timeline.appendChild(card);
      } else if (event.blockType === 'tool_use' || event.blockType === 'server_tool_use') {
        const toolName = event.toolName || 'Unknown';
        toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
        updateToolsList();

        const { card, body } = createCard(kind, event.ts, {
          badge: 'TOOL', badgeClass: 'tool',
          title: toolName,
        });
        const inputLabel = document.createElement('div');
        inputLabel.className = 'section-label';
        inputLabel.textContent = 'INPUT';
        body.appendChild(inputLabel);
        const inputBlock = document.createElement('pre');
        inputBlock.className = 'code-block streaming-cursor';
        body.appendChild(inputBlock);

        activeBlocks[event.blockIndex] = {
          element: inputBlock, card, body, type: 'tool_use',
          content: '', toolId: event.toolId, toolName,
        };
        if (event.toolId) toolCardMap[event.toolId] = { card, body };
        timeline.appendChild(card);
      } else if (event.blockType === 'text') {
        const { card, body } = createCard(kind, event.ts, {
          badge: 'TEXT', badgeClass: 'text',
        });
        const content = document.createElement('div');
        content.className = 'text-content streaming-cursor';
        body.appendChild(content);
        activeBlocks[event.blockIndex] = { element: content, card, type: 'text', content: '' };
        timeline.appendChild(card);
      }
      scrollToBottom();
      return;
    }

    if (kind === 'text_delta') {
      const block = activeBlocks[event.blockIndex];
      if (block) {
        block.content += event.text;
        block.element.textContent = block.content;
        scrollToBottom();
      }
      return;
    }

    if (kind === 'thinking_delta') {
      const block = activeBlocks[event.blockIndex];
      if (block) {
        block.content += event.text;
        block.element.textContent = block.content;
        scrollToBottom();
      }
      return;
    }

    if (kind === 'tool_input_delta') {
      const block = activeBlocks[event.blockIndex];
      if (block) {
        block.content += event.partialJson;
        // Try to pretty-print
        try {
          block.element.textContent = JSON.stringify(JSON.parse(block.content), null, 2);
        } catch {
          block.element.textContent = block.content;
        }
        scrollToBottom();
      }
      return;
    }

    if (kind === 'block_stop') {
      const block = activeBlocks[event.blockIndex];
      if (block) {
        block.element.classList.remove('streaming-cursor');

        if (block.type === 'tool_use' && block.content) {
          // Finalize the tool input JSON
          try {
            block.element.textContent = JSON.stringify(JSON.parse(block.content), null, 2);
          } catch {
            block.element.textContent = block.content;
          }
          // Collapse if long
          const lines = block.element.textContent.split('\n').length;
          if (lines > 15) {
            block.element.classList.add('collapsed');
            const btn = document.createElement('button');
            btn.className = 'expand-btn';
            btn.textContent = `Show all (${lines} lines)`;
            btn.addEventListener('click', () => {
              const isCollapsed = block.element.classList.contains('collapsed');
              block.element.classList.toggle('collapsed');
              btn.textContent = isCollapsed ? 'Collapse' : `Show all (${lines} lines)`;
            });
            block.body.appendChild(btn);
          }
        }

        delete activeBlocks[event.blockIndex];
      }
      return;
    }

    // --- Complete message mode events ---
    if (kind === 'text') {
      const { card, body } = createCard(kind, event.ts, {
        badge: 'TEXT', badgeClass: 'text',
      });
      const content = document.createElement('div');
      content.className = 'text-content';
      content.textContent = event.text;
      body.appendChild(content);
      timeline.appendChild(card);
      scrollToBottom();
      return;
    }

    if (kind === 'thinking') {
      const { card, body } = createCard(kind, event.ts, {
        badge: 'THINK', badgeClass: 'think',
        title: 'Thinking',
        collapsible: true,
      });
      const content = document.createElement('div');
      content.className = 'thinking-content';
      content.textContent = event.text;
      body.appendChild(content);
      timeline.appendChild(card);
      scrollToBottom();
      return;
    }

    if (kind === 'tool_call') {
      const toolName = event.toolName || 'Unknown';
      toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
      updateToolsList();

      const { card, body } = createCard(kind, event.ts, {
        badge: 'TOOL', badgeClass: 'tool',
        title: toolName,
      });
      const inputLabel = document.createElement('div');
      inputLabel.className = 'section-label';
      inputLabel.textContent = 'INPUT';
      body.appendChild(inputLabel);
      addCodeBlock(body, formatJson(event.input));

      if (event.toolId) toolCardMap[event.toolId] = { card, body };
      timeline.appendChild(card);
      scrollToBottom();
      return;
    }

    if (kind === 'tool_result') {
      // Try to attach to the matching tool call card
      const existing = toolCardMap[event.toolId];
      if (existing) {
        const resultLabel = document.createElement('div');
        resultLabel.className = 'section-label';
        resultLabel.textContent = event.isError ? 'ERROR' : 'OUTPUT';
        existing.body.appendChild(resultLabel);
        addCodeBlock(existing.body, event.content || '(empty)', { isError: event.isError });
        scrollToBottom();
        return;
      }

      // Standalone result card
      const { card, body } = createCard(kind, event.ts, {
        badge: event.isError ? 'ERROR' : 'RESULT',
        badgeClass: event.isError ? 'error' : 'result',
        title: `Tool result${event.toolId ? ` (${event.toolId.slice(0, 12)})` : ''}`,
      });
      addCodeBlock(body, event.content || '(empty)', { isError: event.isError });
      timeline.appendChild(card);
      scrollToBottom();
      return;
    }

    if (kind === 'session_end') {
      if (event.costUsd) {
        usage.costUsd = event.costUsd;
        statCost.textContent = `$${event.costUsd.toFixed(4)}`;
      }
      if (event.durationMs) statDuration.textContent = formatDuration(event.durationMs);
      if (event.numTurns) statTurns.textContent = event.numTurns;

      const { card, body } = createCard(kind, event.ts, {
        badge: 'END', badgeClass: 'system',
        title: event.isError ? 'Session ended with error' : 'Session complete',
      });
      if (event.result) {
        const content = document.createElement('div');
        content.className = 'text-content';
        content.textContent = truncateText(event.result, 500);
        body.appendChild(content);
      }
      timeline.appendChild(card);
      sessionEnded = true;
      statusDot.className = 'status-dot ended';
      statusText.textContent = 'Session ended';
      scrollToBottom();
      return;
    }

    if (kind === 'session_complete') {
      if (event.durationMs) statDuration.textContent = formatDuration(event.durationMs);
      sessionEnded = true;
      statusDot.className = 'status-dot ended';
      statusText.textContent = 'Session complete';

      const { card } = createCard(kind, event.ts, {
        badge: 'DONE', badgeClass: 'system',
        title: 'Pipe closed — session complete',
      });
      timeline.appendChild(card);
      scrollToBottom();
      return;
    }

    if (kind === 'session_resumed') {
      statusDot.className = 'status-dot streaming';
      statusText.textContent = 'Resumed';

      const { card } = createCard(kind, event.ts, {
        badge: 'RESUME', badgeClass: 'system',
        title: 'Session resumed',
      });
      timeline.appendChild(card);
      scrollToBottom();
      return;
    }

    if (kind === 'raw') {
      const { card, body } = createCard(kind, event.ts, {
        badge: 'RAW', badgeClass: 'system',
      });
      addCodeBlock(body, event.text || JSON.stringify(event.data, null, 2));
      timeline.appendChild(card);
      scrollToBottom();
      return;
    }
  }

  // --- WebSocket connection ---
  let ws;
  let reconnectTimer;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      statusDot.className = 'status-dot connected';
      statusText.textContent = 'Connected';
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      if (msg.type === 'snapshot') {
        // Full state replay
        const snap = msg.data;
        if (snap.model) modelBadge.textContent = snap.model;
        if (snap.sessionId) sessionBadge.textContent = snap.sessionId.slice(0, 12);
        if (snap.usage) {
          usage = { ...usage, ...snap.usage };
          updateStats();
        }
        // Replay all events
        timeline.innerHTML = '';
        for (const evt of snap.events) {
          handleEvent(evt);
        }
      } else if (msg.type === 'event') {
        handleEvent(msg.data);
      }
    };

    ws.onclose = () => {
      if (!sessionEnded) {
        statusDot.className = 'status-dot disconnected';
        statusText.textContent = 'Disconnected — reconnecting...';
        reconnectTimer = setTimeout(connect, 2000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  // --- Check for saved session mode (?session=id) ---
  const urlParams = new URLSearchParams(window.location.search);
  const savedSessionId = urlParams.get('session');

  if (savedSessionId) {
    // Load a saved session from the API instead of connecting via WebSocket
    statusDot.className = 'status-dot ended';
    statusText.textContent = 'Loading saved session...';

    fetch(`/api/sessions/${encodeURIComponent(savedSessionId)}`)
      .then(res => {
        if (!res.ok) throw new Error('Session not found');
        return res.json();
      })
      .then(data => {
        statusText.textContent = 'Saved session';
        for (const evt of data.events) {
          handleEvent(evt);
        }
        sessionEnded = true;
      })
      .catch(err => {
        statusText.textContent = `Error: ${err.message}`;
      });
  } else {
    // Live mode — connect via WebSocket
    connect();
  }
})();
