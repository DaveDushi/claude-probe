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
  const cwdBadge = document.getElementById('cwd-badge');

  // Filters
  const filters = {
    user: document.getElementById('filter-user'),
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
    if (kind === 'user_message') return 'user';
    if (['text', 'text_delta'].includes(kind)) return 'text';
    if (['tool_call', 'tool_input_delta', 'block_start'].includes(kind)) return 'tool';
    if (['thinking', 'thinking_delta'].includes(kind)) return 'thinking';
    if (['tool_result'].includes(kind)) return 'result';
    return 'system';
  }

  function applyFilters() {
    document.querySelectorAll('.chat-row').forEach(row => {
      const cat = row.dataset.category;
      if (cat && filters[cat]) {
        row.style.display = filters[cat].checked ? '' : 'none';
      }
    });
  }

  Object.values(filters).forEach(cb => cb.addEventListener('change', applyFilters));

  // --- Chat UI render helpers ---

  function createChatBubble(timestamp, isUser) {
    const cat = isUser ? 'user' : 'text';
    const row = document.createElement('div');
    row.className = `chat-row ${isUser ? 'user-row' : 'assistant-row'}`;
    row.dataset.category = cat;
    if (filters[cat] && !filters[cat].checked) row.style.display = 'none';

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isUser ? 'user-bubble' : 'assistant-bubble'}`;

    const content = document.createElement('div');
    content.className = 'bubble-content';
    bubble.appendChild(content);

    const meta = document.createElement('span');
    meta.className = 'bubble-meta';
    meta.textContent = formatTime(timestamp);
    bubble.appendChild(meta);

    row.appendChild(bubble);
    return { row, bubble, content };
  }

  function createAccordion(timestamp, category, opts = {}) {
    const row = document.createElement('div');
    row.className = 'chat-row assistant-row';
    row.dataset.category = category;
    if (filters[category] && !filters[category].checked) row.style.display = 'none';

    const block = document.createElement('div');
    block.className = `chat-accordion ${opts.className || ''}`;

    const header = document.createElement('div');
    header.className = 'accordion-header';

    if (opts.icon) {
      const icon = document.createElement('span');
      icon.className = 'accordion-icon';
      icon.textContent = opts.icon;
      header.appendChild(icon);
    }

    const label = document.createElement('span');
    label.className = 'accordion-label';
    label.textContent = opts.label || '';
    header.appendChild(label);

    const chevron = document.createElement('span');
    chevron.className = 'accordion-chevron';
    chevron.textContent = '\u203A';
    header.appendChild(chevron);

    const body = document.createElement('div');
    body.className = 'accordion-body';

    header.addEventListener('click', () => {
      block.classList.toggle('expanded');
    });

    block.appendChild(header);
    block.appendChild(body);
    row.appendChild(block);
    return { row, block, body, header, label };
  }

  function createSystemDivider(timestamp, text) {
    const row = document.createElement('div');
    row.className = 'chat-row system-row';
    row.dataset.category = 'system';
    if (filters.system && !filters.system.checked) row.style.display = 'none';

    const divider = document.createElement('div');
    divider.className = 'system-divider';
    divider.textContent = formatTime(timestamp) + ' \u00b7 ' + text;

    row.appendChild(divider);
    return { row, divider };
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
      return;
    }

    if (kind === 'session_start') {
      if (event.cwd && cwdBadge) {
        cwdBadge.textContent = event.cwd;
        cwdBadge.title = event.cwd;
      }
      return;
    }

    if (kind === 'init') {
      modelBadge.textContent = event.model || '';
      sessionBadge.textContent = event.sessionId ? event.sessionId.slice(0, 12) : '';
      statusDot.className = 'status-dot streaming';
      statusText.textContent = 'Streaming';

      const { row, divider } = createSystemDivider(event.ts, 'Session initialized');
      if (event.tools && event.tools.length > 0) {
        divider.textContent += ` \u00b7 ${event.tools.length} tools`;
      }
      timeline.appendChild(row);
      scrollToBottom();
      return;
    }

    if (kind === 'stream_message_start') {
      if (event.model) modelBadge.textContent = event.model;
      statusDot.className = 'status-dot streaming';
      statusText.textContent = 'Streaming';
      return;
    }

    if (kind === 'stream_message_delta' || kind === 'stream_message_stop' || kind === 'signature_delta') {
      return;
    }

    // --- Block-based streaming events ---
    if (kind === 'block_start') {
      if (event.blockType === 'thinking') {
        const { row, block, body, label } = createAccordion(event.ts, 'thinking', {
          icon: '\u2726', label: 'Thinking\u2026', className: 'thinking-accordion',
        });
        const content = document.createElement('div');
        content.className = 'thinking-content streaming-cursor';
        body.appendChild(content);
        activeBlocks[event.blockIndex] = { element: content, card: block, type: 'thinking', content: '', label };
        timeline.appendChild(row);
      } else if (event.blockType === 'tool_use' || event.blockType === 'server_tool_use') {
        const toolName = event.toolName || 'Unknown';
        toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
        updateToolsList();

        const { row, block, body } = createAccordion(event.ts, 'tool', {
          icon: '\u26A1', label: toolName, className: 'tool-accordion',
        });
        const inputLabel = document.createElement('div');
        inputLabel.className = 'section-label';
        inputLabel.textContent = 'INPUT';
        body.appendChild(inputLabel);
        const inputBlock = document.createElement('pre');
        inputBlock.className = 'code-block streaming-cursor';
        body.appendChild(inputBlock);

        activeBlocks[event.blockIndex] = {
          element: inputBlock, card: block, body, type: 'tool_use',
          content: '', toolId: event.toolId, toolName,
        };
        if (event.toolId) toolCardMap[event.toolId] = { card: block, body };
        timeline.appendChild(row);
      } else if (event.blockType === 'text') {
        const { row, bubble, content } = createChatBubble(event.ts, false);
        content.classList.add('streaming-cursor');
        activeBlocks[event.blockIndex] = { element: content, card: bubble, type: 'text', content: '' };
        timeline.appendChild(row);
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

        // Update thinking label to past tense
        if (block.type === 'thinking' && block.label) {
          block.label.textContent = 'Thought';
        }

        if (block.type === 'tool_use' && block.content) {
          try {
            block.element.textContent = JSON.stringify(JSON.parse(block.content), null, 2);
          } catch {
            block.element.textContent = block.content;
          }
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

    // --- User message (from agent/OpenClaw) ---
    if (kind === 'user_message') {
      const { row, content } = createChatBubble(event.ts, true);
      content.textContent = event.text;
      timeline.appendChild(row);
      scrollToBottom();
      return;
    }

    // --- Complete message mode events ---
    if (kind === 'text') {
      const { row, content } = createChatBubble(event.ts, false);
      content.textContent = event.text;
      timeline.appendChild(row);
      scrollToBottom();
      return;
    }

    if (kind === 'thinking') {
      const { row, body } = createAccordion(event.ts, 'thinking', {
        icon: '\u2726', label: 'Thought', className: 'thinking-accordion',
      });
      const content = document.createElement('div');
      content.className = 'thinking-content';
      content.textContent = event.text;
      body.appendChild(content);
      timeline.appendChild(row);
      scrollToBottom();
      return;
    }

    if (kind === 'tool_call') {
      const toolName = event.toolName || 'Unknown';
      toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
      updateToolsList();

      const { row, block, body } = createAccordion(event.ts, 'tool', {
        icon: '\u26A1', label: toolName, className: 'tool-accordion',
      });
      const inputLabel = document.createElement('div');
      inputLabel.className = 'section-label';
      inputLabel.textContent = 'INPUT';
      body.appendChild(inputLabel);
      addCodeBlock(body, formatJson(event.input));

      if (event.toolId) toolCardMap[event.toolId] = { card: block, body };
      timeline.appendChild(row);
      scrollToBottom();
      return;
    }

    if (kind === 'tool_result') {
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
      // Standalone result — use accordion
      const { row, body } = createAccordion(event.ts, 'result', {
        icon: event.isError ? '\u2717' : '\u2713',
        label: `Result${event.toolId ? ' (' + event.toolId.slice(0, 8) + ')' : ''}`,
        className: event.isError ? 'tool-accordion error-accordion' : 'tool-accordion',
      });
      addCodeBlock(body, event.content || '(empty)', { isError: event.isError });
      timeline.appendChild(row);
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

      const label = event.isError ? 'Session ended with error' : 'Session complete';
      const { row, divider } = createSystemDivider(event.ts, label);
      if (event.costUsd) divider.textContent += ` \u00b7 $${event.costUsd.toFixed(4)}`;
      timeline.appendChild(row);
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
      const { row } = createSystemDivider(event.ts, 'Session complete');
      timeline.appendChild(row);
      scrollToBottom();
      return;
    }

    if (kind === 'session_resumed') {
      statusDot.className = 'status-dot streaming';
      statusText.textContent = 'Resumed';
      const { row } = createSystemDivider(event.ts, 'Session resumed');
      timeline.appendChild(row);
      scrollToBottom();
      return;
    }

    if (kind === 'approval_granted') {
      const { row } = createSystemDivider(event.ts, 'Approved: ' + (event.toolName || ''));
      timeline.appendChild(row);
      scrollToBottom();
      return;
    }

    if (kind === 'approval_denied') {
      const text = 'Denied: ' + (event.toolName || '') + (event.message ? ' \u2014 ' + event.message : '');
      const { row } = createSystemDivider(event.ts, text);
      timeline.appendChild(row);
      scrollToBottom();
      return;
    }

    if (kind === 'session_timeout') {
      const { row } = createSystemDivider(event.ts, event.message || 'Session timed out');
      timeline.appendChild(row);
      statusDot.className = 'status-dot ended';
      statusText.textContent = 'Timed out';
      sessionEnded = true;
      scrollToBottom();
      return;
    }

    if (kind === 'raw') {
      const { row, body } = createAccordion(event.ts, 'system', {
        icon: '\u2026', label: 'Raw event', className: 'tool-accordion',
      });
      addCodeBlock(body, event.text || JSON.stringify(event.data, null, 2));
      timeline.appendChild(row);
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
    // Load existing events, then connect WS for live updates
    statusDot.className = 'status-dot connected';
    statusText.textContent = 'Loading session...';

    const seenEventIds = new Set();

    fetch(`/api/sessions/${encodeURIComponent(savedSessionId)}`)
      .then(res => {
        if (!res.ok) throw new Error('Session not found');
        return res.json();
      })
      .then(data => {
        // Set cwd from API response if available
        if (data.cwd && cwdBadge) {
          cwdBadge.textContent = data.cwd;
          cwdBadge.title = data.cwd;
        }

        for (const evt of data.events) {
          seenEventIds.add(evt.id);
          handleEvent(evt);
        }

        // If session is still active, connect WS for live updates
        const isActive = data.status && data.status !== 'done' && data.status !== 'error';
        if (isActive) {
          statusText.textContent = `Live — ${data.status}`;
          statusDot.className = 'status-dot streaming';
        } else {
          statusText.textContent = 'Session complete';
          sessionEnded = true;
        }

        // Always connect WS to catch late events and status changes
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const liveWs = new WebSocket(`${proto}//${location.host}`);
        liveWs.onmessage = (e) => {
          let msg;
          try { msg = JSON.parse(e.data); } catch { return; }

          // Only process events for this session
          if (msg.type === 'event' && msg.sessionId === savedSessionId) {
            if (!seenEventIds.has(msg.data.id)) {
              seenEventIds.add(msg.data.id);
              handleEvent(msg.data);
            }
          }

          // Session status updates
          if (msg.type === 'session_status' && msg.sessionId === savedSessionId) {
            if (msg.status === 'done' || msg.status === 'error') {
              sessionEnded = true;
              statusDot.className = 'status-dot ended';
              statusText.textContent = 'Session complete';
            } else if (msg.status === 'waiting_approval') {
              statusDot.className = 'status-dot connected';
              statusText.textContent = 'Awaiting approval';
            } else if (msg.status === 'running') {
              statusDot.className = 'status-dot streaming';
              statusText.textContent = 'Streaming';
            } else if (msg.status === 'idle') {
              statusDot.className = 'status-dot connected';
              statusText.textContent = 'Idle — waiting for input';
            }
          }

          // Snapshot — ignore for session-specific view
          if (msg.type === 'snapshot') return;
        };
        liveWs.onclose = () => {
          if (!sessionEnded) {
            statusText.textContent += ' (disconnected)';
          }
        };
      })
      .catch(err => {
        statusText.textContent = `Error: ${err.message}`;
      });
  } else {
    // Live mode — connect via WebSocket
    connect();
  }

  // Sidebar toggle for mobile
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  if (sidebarToggle && sidebar) {
    sidebarToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
    document.getElementById('timeline-container').addEventListener('click', () => {
      sidebar.classList.remove('open');
    });
  }
})();
