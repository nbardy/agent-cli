import { failureEvents } from '../diagnostics.ts';
import { asObject, asString } from '../json-utils.ts';
import type { UnifiedAgentEvent } from '../runtime-types.ts';

export function parseMuse(json: unknown): UnifiedAgentEvent[] {
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
      return text ? [{ type: 'text.delta', text }] : [];
    }
    case 'run.terminal.completed': {
      const text = asString(payload?.text);
      if (text) {
        return [
          { type: 'text.delta', text },
          { type: 'turn.complete', reason: 'success' },
        ];
      }
      return [{ type: 'turn.complete', reason: 'success' }];
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
}
