import { failureEvents } from '../diagnostics.ts';
import { asObject, asString, normalizeType } from '../json-utils.ts';
import type { UnifiedAgentEvent } from '../runtime-types.ts';

function extractAssistantText(obj: Record<string, unknown>): string | undefined {
  const direct = asString(obj.text);
  if (direct) return direct;
  const part = asObject(obj.part);
  const partText = asString(part?.text) ?? asString(asObject(part?.delta)?.text);
  if (partText) return partText;
  const message = asObject(obj.message);
  const messageText = asString(message?.text) ?? asString(message?.content);
  if (messageText) return messageText;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  const chunks = content.map((entry) => asString(asObject(entry)?.text)).filter(Boolean);
  return chunks.length > 0 ? chunks.join('') : undefined;
}

export function parseOpenCode(json: unknown): UnifiedAgentEvent[] {
  const obj = asObject(json);
  if (!obj) return [{ type: 'error', message: 'OpenCode emitted non-object JSON' }];
  const eventType = normalizeType(asString(obj.type)) ?? normalizeType(asString(asObject(obj.part)?.type));

  switch (eventType) {
    case 'step_start':
      return [{ type: 'turn.started' }];
    case 'text': {
      const text = extractAssistantText(obj);
      return text ? [{ type: 'text.delta', text }] : [];
    }
    case 'tool_use':
    case 'tool': {
      const part = asObject(obj.part) ?? {};
      return [{
        type: 'tool.use',
        name: asString(part.tool) ?? asString(obj.tool) ?? 'tool',
        input: asObject(asObject(part.state)?.input) ?? {},
      }];
    }
    case 'step_finish': {
      const part = asObject(obj.part);
      const reasonRaw = asString(part?.reason) ?? asString(obj.reason);
      const reason = normalizeType(reasonRaw);
      if (reason === 'tool_calls') return [];
      if (reason && ['failed', 'error', 'abort', 'aborted', 'cancel', 'cancelled', 'canceled'].includes(reason)) {
        return failureEvents(`OpenCode step failed (${reasonRaw ?? 'unknown'})`);
      }
      return [{ type: 'turn.complete', reason: 'success' }];
    }
    case 'done':
    case 'complete':
    case 'message_complete':
    case 'response_complete':
      return [{ type: 'turn.complete', reason: 'success' }];
    case 'error':
      return failureEvents(
        asString(obj.message) ?? asString(asObject(obj.error)?.message) ?? 'OpenCode error',
        false
      );
    default: {
      const text = extractAssistantText(obj);
      return text ? [{ type: 'text.delta', text }] : [];
    }
  }
}
