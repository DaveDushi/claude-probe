class SessionState {
  constructor() {
    this.events = [];
    this.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation: 0,
      cacheRead: 0,
      costUsd: 0,
    };
    this.model = null;
    this.sessionId = null;
    this.startTime = Date.now();
    this.activeBlocks = {}; // index -> { type, content, toolName, toolId }
    this.toolResults = {};  // toolId -> result content
  }

  addEvent(event) {
    this.events.push(event);

    switch (event.kind) {
      case 'init':
        this.model = event.model;
        this.sessionId = event.sessionId;
        break;

      case 'stream_message_start':
        if (event.model) this.model = event.model;
        break;

      case 'usage':
        // For streaming, output_tokens is cumulative in message_delta
        // For complete messages, each assistant message has its own usage
        if (event.inputTokens) this.usage.inputTokens += event.inputTokens;
        if (event.outputTokens) this.usage.outputTokens = Math.max(this.usage.outputTokens, event.outputTokens) || this.usage.outputTokens + event.outputTokens;
        if (event.cacheCreation) this.usage.cacheCreation += event.cacheCreation;
        if (event.cacheRead) this.usage.cacheRead += event.cacheRead;
        break;

      case 'session_end':
        if (event.costUsd) this.usage.costUsd = event.costUsd;
        break;

      case 'block_start':
        this.activeBlocks[event.blockIndex] = {
          type: event.blockType,
          content: '',
          toolName: event.toolName || null,
          toolId: event.toolId || null,
        };
        break;

      case 'text_delta': {
        const block = this.activeBlocks[event.blockIndex];
        if (block) block.content += event.text;
        break;
      }

      case 'thinking_delta': {
        const block = this.activeBlocks[event.blockIndex];
        if (block) block.content += event.text;
        break;
      }

      case 'tool_input_delta': {
        const block = this.activeBlocks[event.blockIndex];
        if (block) block.content += event.partialJson;
        break;
      }

      case 'block_stop': {
        const block = this.activeBlocks[event.blockIndex];
        if (block && block.type === 'tool_use') {
          // Try to parse accumulated JSON
          try {
            block.parsedInput = JSON.parse(block.content);
          } catch {
            block.parsedInput = block.content;
          }
        }
        delete this.activeBlocks[event.blockIndex];
        break;
      }

      case 'tool_result':
        this.toolResults[event.toolId] = {
          content: event.content,
          isError: event.isError,
        };
        break;

      case 'tool_call':
        // Complete mode tool call — store for matching with result
        break;
    }

    return event;
  }

  getSnapshot() {
    return {
      events: this.events,
      usage: { ...this.usage },
      model: this.model,
      sessionId: this.sessionId,
      startTime: this.startTime,
      activeBlocks: { ...this.activeBlocks },
    };
  }
}

module.exports = { SessionState };
