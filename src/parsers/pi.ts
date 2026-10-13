import { failureEvents } from '../diagnostics.ts';
import { asObject, asString } from '../json-utils.ts';
import type { UnifiedAgentEvent } from '../runtime-types.ts';

// Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate)
export function createPiParser(): (json: unknown) => UnifiedAgentEvent[] {
  let failure: string | undefined;
  let streamed = false;
  return (json) => {
    const event = asObject(json);
    if (!event) return [];
    const type = asString(event.type);
    if (type === 'message_start') streamed = false;
    if (type === 'message_update') {
      const delta = asObject(event.assistantMessageEvent);
      if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
        streamed = true;
        return [{ type: 'text.delta', text: delta.delta }];
      }
    }
    if (type === 'tool_execution_start') {
      return [{ type: 'tool.use', name: asString(event.toolName) ?? 'tool', input: asObject(event.args) ?? {} }];
    }
    if (type === 'tool_execution_end') {
      return [{ type: 'tool.result', output: event.result, isError: event.isError === true }];
    }
    if (type === 'message_end') {
      const message = asObject(event.message);
      if (message?.role !== 'assistant') return [];
      const events: UnifiedAgentEvent[] = [];
      if (!streamed && Array.isArray(message.content)) {
        for (const block of message.content) {
          const part = asObject(block);
          if (part?.type === 'text' && typeof part.text === 'string') events.push({ type: 'text.delta', text: part.text });
        }
      }
      const usage = asObject(message.usage);
      if (usage && typeof usage.input === 'number' && typeof usage.output === 'number') {
        const cacheRead = typeof usage.cacheRead === 'number' ? usage.cacheRead : 0;
        const cacheWrite = typeof usage.cacheWrite === 'number' ? usage.cacheWrite : 0;
        events.push({ type: 'usage', usage: { contextTokens: usage.input + cacheRead + cacheWrite, outputTokens: usage.output, cachedInputTokens: cacheRead, cacheWriteTokens: cacheWrite } });
      }
      failure = message.stopReason === 'error' ? (asString(message.errorMessage) ?? 'Pi provider failed') : undefined;
      return events;
    }
    // SoL-Pi may compact and start another run after agent_end. Closing there
    // truncates its continuation. Guard: pi.test.ts settlement test.
    if (type === 'agent_settled') {
      if (failure) return failureEvents(failure);
      return [{ type: 'turn.complete', reason: event.aborted === true ? 'killed' : 'success' }];
    }
    return [{ type: 'progress', source: `pi.${type ?? 'unknown'}` }];
  };
}
