import { ProbeEvent } from './state';

let eventCounter = 0;

function makeId(): string {
  return `evt_${Date.now()}_${++eventCounter}`;
}

function makeEvent(kind: string, payload: Record<string, unknown>): ProbeEvent {
  return { id: makeId(), ts: Date.now(), kind, ...payload };
}

/**
 * Parse a single NDJSON line from Claude Code's stream-json output.
 * Returns an array of normalized events (usually 1, sometimes 0).
 */
export function parseLine(line: string): ProbeEvent[] {
  line = line.trim();
  if (!line) return [];

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return [makeEvent('raw', { text: line })];
  }

  const type = obj.type as string;

  if (type === 'system') {
    return [makeEvent('init', {
      subtype: obj.subtype,
      sessionId: obj.session_id,
      model: obj.model,
      tools: obj.tools || [],
      mcp_servers: obj.mcp_servers || [],
    })];
  }

  if (type === 'assistant') {
    return parseAssistantMessage(obj.message as AssistantMessage);
  }

  if (type === 'user') {
    return parseUserMessage(obj.message as UserMessage);
  }

  if (type === 'result') {
    return [makeEvent('session_end', {
      result: obj.result,
      costUsd: obj.total_cost_usd || obj.cost_usd,
      durationMs: obj.duration_ms,
      durationApiMs: obj.duration_api_ms,
      isError: obj.is_error,
      numTurns: obj.num_turns,
      sessionId: obj.session_id,
    })];
  }

  if (type === 'stream_event') {
    return parseStreamEvent(obj.event as StreamEvent);
  }

  // Unknown top-level type — pass through as raw
  return [makeEvent('raw', { data: obj })];
}

// ================================================================
// Internal types for Claude protocol messages
// ================================================================

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
}

interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AssistantMessage {
  content?: ContentBlock[];
  usage?: UsageInfo;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

interface UserMessage {
  content?: string | (ContentBlock | ToolResultBlock)[];
}

interface StreamEvent {
  type: string;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    usage?: UsageInfo;
  };
  content_block?: ContentBlock;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: UsageInfo;
}

// ================================================================
// Message parsers
// ================================================================

function parseAssistantMessage(msg: AssistantMessage): ProbeEvent[] {
  if (!msg || !msg.content) return [];
  const events: ProbeEvent[] = [];

  for (const block of msg.content) {
    if (block.type === 'text') {
      events.push(makeEvent('text', { text: block.text }));
    } else if (block.type === 'tool_use') {
      events.push(makeEvent('tool_call', {
        toolName: block.name,
        toolId: block.id,
        input: block.input,
      }));
    } else if (block.type === 'thinking') {
      events.push(makeEvent('thinking', { text: block.thinking }));
    } else if (block.type === 'server_tool_use') {
      events.push(makeEvent('tool_call', {
        toolName: block.name,
        toolId: block.id,
        input: block.input,
        serverTool: true,
      }));
    }
  }

  if (msg.usage) {
    events.push(makeEvent('usage', {
      inputTokens: msg.usage.input_tokens || 0,
      outputTokens: msg.usage.output_tokens || 0,
      cacheCreation: msg.usage.cache_creation_input_tokens || 0,
      cacheRead: msg.usage.cache_read_input_tokens || 0,
    }));
  }

  return events;
}

function parseUserMessage(msg: UserMessage): ProbeEvent[] {
  if (!msg || !msg.content) return [];
  const events: ProbeEvent[] = [];

  const content: (ContentBlock | ToolResultBlock)[] = Array.isArray(msg.content)
    ? msg.content
    : [{ type: 'text', text: String(msg.content) }];

  for (const block of content) {
    if (block.type === 'tool_result') {
      const toolBlock = block as ToolResultBlock;
      const resultContent = typeof toolBlock.content === 'string'
        ? toolBlock.content
        : Array.isArray(toolBlock.content)
          ? toolBlock.content.map(c => c.text || JSON.stringify(c)).join('\n')
          : JSON.stringify(toolBlock.content);

      events.push(makeEvent('tool_result', {
        toolId: toolBlock.tool_use_id,
        content: resultContent,
        isError: toolBlock.is_error || false,
      }));
    }
  }

  return events;
}

function parseStreamEvent(evt: StreamEvent): ProbeEvent[] {
  if (!evt) return [];
  const type = evt.type;

  if (type === 'message_start') {
    const msg = evt.message || {};
    const events: ProbeEvent[] = [makeEvent('stream_message_start', {
      messageId: msg.id,
      model: msg.model,
      role: msg.role,
    })];
    if (msg.usage) {
      events.push(makeEvent('usage', {
        inputTokens: msg.usage.input_tokens || 0,
        outputTokens: msg.usage.output_tokens || 0,
        cacheCreation: msg.usage.cache_creation_input_tokens || 0,
        cacheRead: msg.usage.cache_read_input_tokens || 0,
      }));
    }
    return events;
  }

  if (type === 'content_block_start') {
    const block = evt.content_block || {} as ContentBlock;
    const index = evt.index;

    if (block.type === 'text') {
      return [makeEvent('block_start', { blockIndex: index, blockType: 'text' })];
    }
    if (block.type === 'tool_use') {
      return [makeEvent('block_start', {
        blockIndex: index,
        blockType: 'tool_use',
        toolName: block.name,
        toolId: block.id,
      })];
    }
    if (block.type === 'thinking') {
      return [makeEvent('block_start', { blockIndex: index, blockType: 'thinking' })];
    }
    if (block.type === 'server_tool_use') {
      return [makeEvent('block_start', {
        blockIndex: index,
        blockType: 'server_tool_use',
        toolName: block.name,
        toolId: block.id,
      })];
    }
    return [makeEvent('block_start', { blockIndex: index, blockType: block.type })];
  }

  if (type === 'content_block_delta') {
    const delta = evt.delta || {};
    const index = evt.index;

    if (delta.type === 'text_delta') {
      return [makeEvent('text_delta', { blockIndex: index, text: delta.text })];
    }
    if (delta.type === 'input_json_delta') {
      return [makeEvent('tool_input_delta', { blockIndex: index, partialJson: delta.partial_json })];
    }
    if (delta.type === 'thinking_delta') {
      return [makeEvent('thinking_delta', { blockIndex: index, text: delta.thinking })];
    }
    if (delta.type === 'signature_delta') {
      return [makeEvent('signature_delta', { blockIndex: index, signature: delta.signature })];
    }
    return [];
  }

  if (type === 'content_block_stop') {
    return [makeEvent('block_stop', { blockIndex: evt.index })];
  }

  if (type === 'message_delta') {
    const events: ProbeEvent[] = [];
    if (evt.delta) {
      events.push(makeEvent('stream_message_delta', {
        stopReason: evt.delta.stop_reason,
      }));
    }
    if (evt.usage) {
      events.push(makeEvent('usage', {
        inputTokens: evt.usage.input_tokens || 0,
        outputTokens: evt.usage.output_tokens || 0,
        cacheCreation: evt.usage.cache_creation_input_tokens || 0,
        cacheRead: evt.usage.cache_read_input_tokens || 0,
      }));
    }
    return events;
  }

  if (type === 'message_stop') {
    return [makeEvent('stream_message_stop', {})];
  }

  if (type === 'ping') {
    return []; // ignore pings
  }

  return [];
}
