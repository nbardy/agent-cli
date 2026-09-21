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
 *
 * NO `usage` EVENT, and it is not an oversight: muse counts tokens but does
 * not put them on stdout. Measured on Muse Code 1.3.0 -- one `muse exec --json`
 * turn emitted 30 records (task.lifecycle.*, run.*, session.run.linked,
 * runtime.command.accepted, turn.input.user) with zero token fields, while the
 * same run's durable log at
 * ~/.local/share/muse/sessions/<date>/<session>/session.jsonl held 71 records
 * including `runtime.session` -> `model_completed` with
 * {input_tokens, output_tokens, cached_tokens, cache_write_tokens,
 * cache_read_tokens, reasoning_tokens}. `muse exec --help` offers no event
 * filter, so the only way to reach those numbers is to read that file --
 * a different mechanism (path resolution, tailing) than parsing stdout, and
 * one the caller can do without a harness change. Re-probe before assuming
 * this is still true; the shape is muse's to change.
 */

/**
 * Muse names each scheduled unit of internal work with a dotted `operation`,
 * and only one of the three kinds that appear is a tool the model invoked.
 * Measured on Muse Code 1.3.0 over a live `muse exec --json` turn that ran
 * three bash commands -- 100 stdout records:
 *
 *   tool:bash            x3   a real tool call, about to start
 *   model.meta.response  x4   a model round-trip muse is about to make
 *   reminder.child_run   x4   muse prompting itself
 *
 * Emitting all three as `tool.use` is what put rows like `model.meta.response`
 * in unleashd's tool history. Only `tool:` survives as a tool here; everything
 * else becomes hidden `progress`, which still counts as provider liveness for
 * the stall watchdog but never renders. Nothing is dropped silently.
 *
 * Worth knowing before trusting a record: ONLY
 * `task.lifecycle.side_effect_intent` carries an `operation` at all. The
 * proposed/accepted/scheduled/started/completed records -- 70 of those 100 --
 * carry none and already yielded nothing.
 */
const MUSE_TOOL_OPERATION_PREFIX = 'tool:';
const MUSE_MODEL_OPERATION_PREFIX = 'model.';

type MuseOperation =
  | { kind: 'tool'; name: string }
  | { kind: 'model_step' }
  | { kind: 'internal' };

function classifyMuseOperation(operation: string): MuseOperation {
  if (operation.startsWith(MUSE_TOOL_OPERATION_PREFIX)) {
    return { kind: 'tool', name: operation.slice(MUSE_TOOL_OPERATION_PREFIX.length) };
  }
  if (operation.startsWith(MUSE_MODEL_OPERATION_PREFIX)) {
    return { kind: 'model_step' };
  }
  return { kind: 'internal' };
}

export function createMuseParser(): (json: unknown) => UnifiedAgentEvent[] {
  let streamed = '';
  /**
   * A tool call announces itself twice: once as the `tool:<name>` intent that
   * starts it, and again inside `tool.result` when it finishes. Announcing the
   * intent is what gives a running tool a live row, so the intent wins and the
   * result's copy is suppressed -- but only for a call we actually saw start.
   * An unmatched `tool.result` still emits its own `tool.use`, because losing a
   * tool call from history is a worse failure than showing it twice. Verified
   * 3/3 intents completed under their own task_id in the capture above.
   */
  const startedTools = new Map<string, number>();

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
      const pending = startedTools.get(name) ?? 0;
      if (pending > 0) {
        startedTools.set(name, pending - 1);
      }
      return [
        ...(pending > 0 ? [] : [{ type: 'tool.use' as const, name, input: {} }]),
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
      if (!operation) return [];
      const classified = classifyMuseOperation(operation);
      switch (classified.kind) {
        case 'tool':
          startedTools.set(classified.name, (startedTools.get(classified.name) ?? 0) + 1);
          return [{ type: 'tool.use', name: classified.name, input: {} }];
        case 'model_step':
          return [{ type: 'progress', source: 'muse.model_step', data: { operation } }];
        case 'internal':
          return [{ type: 'progress', source: 'muse.lifecycle', data: { operation } }];
      }
    }
    default:
      return [];
  }
  };
}
