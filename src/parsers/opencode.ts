import { failureEvents } from '../diagnostics.ts';
import { asNumber, asObject, asString, normalizeType } from '../json-utils.ts';
import type { UnifiedAgentEvent } from '../runtime-types.ts';

/**
 * OpenCode's `tokens` block on step-finish keeps cache hits OUT of `input`,
 * like claude -- its own `total` is the proof: a measured step read
 * input 13,497 + output 3 + reasoning 0 + cache.read 1,792 = total 15,292.
 * So the context is input + cache.read + cache.write, and `total` is the wrong
 * number to show (it folds in output and reasoning, which are not context).
 */
function openCodeUsageEvents(rawTokens: unknown): UnifiedAgentEvent[] {
  const tokens = asObject(rawTokens);
  if (!tokens) return [];
  const input = asNumber(tokens.input);
  if (input === undefined) return [];
  const cache = asObject(tokens.cache);
  const cacheRead = asNumber(cache?.read);
  const cacheWrite = asNumber(cache?.write);
  return [
    {
      type: 'usage',
      usage: {
        contextTokens: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
        outputTokens: asNumber(tokens.output) ?? 0,
        ...(cacheRead === undefined ? {} : { cachedInputTokens: cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
      },
    },
  ];
}

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
  const eventType =
    normalizeType(asString(obj.type)) ?? normalizeType(asString(asObject(obj.part)?.type));

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
      const state = asObject(part.state);
      return [
        {
          type: 'tool.use',
          name: asString(part.tool) ?? asString(obj.tool) ?? 'tool',
          input: asObject(state?.input) ?? {},
        },
        ...(state?.status === 'completed' || state?.status === 'error'
          ? [{
              type: 'tool.result' as const,
              output: state.output,
              isError: state.status === 'error',
            }]
          : []),
      ];
    }
    case 'step_finish': {
      const part = asObject(obj.part);
      // Every step-finish is one model request, so usage rides all of them --
      // including the `tool_calls` step that ends no turn. Mid-turn steps are
      // where the context actually grows.
      const usageEvents = openCodeUsageEvents(part?.tokens ?? obj.tokens);
      const reasonRaw = asString(part?.reason) ?? asString(obj.reason);
      const reason = normalizeType(reasonRaw);
      if (reason === 'tool_calls') return usageEvents;
      if (
        reason &&
        ['failed', 'error', 'abort', 'aborted', 'cancel', 'cancelled', 'canceled'].includes(reason)
      ) {
        return [
          ...usageEvents,
          ...failureEvents(`OpenCode step failed (${reasonRaw ?? 'unknown'})`),
        ];
      }
      return [...usageEvents, { type: 'turn.complete', reason: 'success' }];
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
