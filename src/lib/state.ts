export interface ProbeEvent {
  id: string;
  ts: number;
  kind: string;
  [key: string]: unknown;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  costUsd: number;
}

export interface ActiveBlock {
  type: string;
  content: string;
  toolName: string | null;
  toolId: string | null;
  parsedInput?: unknown;
}

export interface SessionSnapshot {
  events: ProbeEvent[];
  usage: UsageStats;
  model: string | null;
  sessionId: string | null;
  startTime: number;
  activeBlocks: Record<number, ActiveBlock>;
}

export class SessionState {
  events: ProbeEvent[] = [];
  usage: UsageStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreation: 0,
    cacheRead: 0,
    costUsd: 0,
  };
  model: string | null = null;
  sessionId: string | null = null;
  startTime: number = Date.now();
  activeBlocks: Record<number, ActiveBlock> = {};
  toolResults: Record<string, { content: string; isError: boolean }> = {};

  addEvent(event: ProbeEvent): ProbeEvent {
    this.events.push(event);

    switch (event.kind) {
      case 'init':
        this.model = event.model as string;
        this.sessionId = event.sessionId as string;
        break;

      case 'stream_message_start':
        if (event.model) this.model = event.model as string;
        break;

      case 'usage':
        if (event.inputTokens) this.usage.inputTokens += event.inputTokens as number;
        if (event.outputTokens) this.usage.outputTokens = Math.max(this.usage.outputTokens, event.outputTokens as number) || this.usage.outputTokens + (event.outputTokens as number);
        if (event.cacheCreation) this.usage.cacheCreation += event.cacheCreation as number;
        if (event.cacheRead) this.usage.cacheRead += event.cacheRead as number;
        break;

      case 'session_end':
        if (event.costUsd) this.usage.costUsd = event.costUsd as number;
        break;

      case 'block_start':
        this.activeBlocks[event.blockIndex as number] = {
          type: event.blockType as string,
          content: '',
          toolName: (event.toolName as string) || null,
          toolId: (event.toolId as string) || null,
        };
        break;

      case 'text_delta': {
        const block = this.activeBlocks[event.blockIndex as number];
        if (block) block.content += event.text as string;
        break;
      }

      case 'thinking_delta': {
        const block = this.activeBlocks[event.blockIndex as number];
        if (block) block.content += event.text as string;
        break;
      }

      case 'tool_input_delta': {
        const block = this.activeBlocks[event.blockIndex as number];
        if (block) block.content += event.partialJson as string;
        break;
      }

      case 'block_stop': {
        const block = this.activeBlocks[event.blockIndex as number];
        if (block && block.type === 'tool_use') {
          try {
            block.parsedInput = JSON.parse(block.content);
          } catch {
            block.parsedInput = block.content;
          }
        }
        delete this.activeBlocks[event.blockIndex as number];
        break;
      }

      case 'tool_result':
        this.toolResults[event.toolId as string] = {
          content: event.content as string,
          isError: event.isError as boolean,
        };
        break;

      case 'tool_call':
        // Complete mode tool call — store for matching with result
        break;
    }

    return event;
  }

  getSnapshot(): SessionSnapshot {
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
