import { failureEvents } from '../diagnostics.ts';
import { asObject, asString } from '../json-utils.ts';
import type { UnifiedAgentEvent } from '../runtime-types.ts';

/**
 * Muse repeats the ENTIRE final message in `run.terminal.completed` after it
 * has already streamed that same text as `run.output.delta` chunks. Emitting
 * both as `text.delta` breaks the invariant every other parser holds --
 * that text.delta events are non-overlapping increments -- so any consumer
 * that concatenates deltas renders the final message twice.
 *
 * This parser therefore tracks what it has streamed and emits only the
 * not-yet-seen suffix from the terminal event, plus the complete text on
 * `turn.complete` for consumers that want it in one piece.
 */
export function createMuseParser(): (json: unknown) => UnifiedAgentEvent[] {
  let streamed = '';

  return (json: unknown): UnifiedAgentEvent[] => {
  const obj = asObject(json);
  if (!obj) return [{ type: 'error', message: 'Muse emitted non-object JSON' }];
  const payloadType = asString(obj.payload_type);
  if (!payloadType) return [];
  const payload = asObject(obj.payload);

  switch (payloadType) {
    case 'run.lifecycle.started':
    case 'session.run.linked':
      return [{ type: 'turn.started' }];
    case 'run.output.delta': {
      const text = asString(payload?.text);
      if (!text) return [];
      streamed += text;
      return [{ type: 'text.delta', text }];
    }
    case 'run.terminal.completed': {
      const text = asString(payload?.text);
      if (!text) {
        return [{ type: 'turn.complete', reason: 'success', text: streamed }];
      }
      // Normal case: the terminal text is the full message and we have
      // already streamed a prefix of it. Emit only the remainder.
      //
      // If it does NOT extend what we streamed, the two disagree; prefer the
      // terminal text, which muse treats as authoritative. That loses the
      // non-overlap guarantee for one event but never loses content, which is
      // the right trade for a research transcript.
      const suffix = text.startsWith(streamed) ? text.slice(streamed.length) : text;
      const events: UnifiedAgentEvent[] = [];
      if (suffix) {
        events.push({ type: 'text.delta', text: suffix });
      }
      streamed = text.startsWith(streamed) ? text : streamed + text;
      events.push({ type: 'turn.complete', reason: 'success', text: streamed });
      return events;
    }
    case 'task.lifecycle.failed':
    case 'run.terminal.failed': {
      const event = asObject(payload?.event);
      const reason =
        asString(event?.reason) ??
        asString(payload?.reason) ??
        asString(payload?.text) ??
        'Muse run failed';
      return failureEvents(reason);
    }
    case 'tool.result': {
      // The CLI executes MCP tools in-process; this is the observable
      // completion, with the namespaced tool name in correlation_facts.
      const facts = asObject(payload?.correlation_facts);
      const name = asString(facts?.tool_name) ?? 'mcp_tool';
      return [
        { type: 'tool.use', name, input: {} },
        ...(typeof payload?.text === 'string'
          ? [{
              type: 'tool.result' as const,
              output: payload.text,
              isError: facts?.outcome === 'error' || facts?.outcome === 'failed',
            }]
          : []),
      ];
    }
    case 'task.stream.linked':
    case 'task.lifecycle.proposed':
    case 'task.lifecycle.accepted':
    case 'task.lifecycle.started':
    case 'task.lifecycle.scheduled':
    case 'task.lifecycle.side_effect_intent':
    case 'task.lifecycle.completed': {
      const event = asObject(payload?.event);
      const operation = asString(event?.operation) ?? asString((payload as Record<string, unknown>)?.task_kind) ?? '';
      if (operation && !operation.includes('reminder') && !operation.includes('scope-reminder') && !operation.includes('goal-reminder')) {
        return [{ type: 'tool.use', name: operation, input: {} }];
      }
      return [];
    }
    default:
      return [];
  }
  };
}
