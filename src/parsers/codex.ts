import { failureEvents } from '../diagnostics.ts';
import { asNumber, asObject, asString } from '../json-utils.ts';
import type {
  UnifiedAgentEvent,
  UnifiedSubagentStateEvent,
  UnifiedSubagentStatus,
} from '../runtime-types.ts';
import { tokenUsage } from './usage.ts';

const SUBAGENT_OPERATIONS = new Map<string, UnifiedSubagentStateEvent['operation']>([
  ['spawn_agent', 'spawn'],
  ['wait', 'wait'],
  ['send_input', 'message'],
]);

function collabToolInput(item: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const prompt = asString(item.prompt);
  const senderThreadId = asString(item.sender_thread_id);
  const status = asString(item.status);
  if (prompt) input.prompt = prompt;
  if (senderThreadId) input.sender_thread_id = senderThreadId;
  if (status) input.status = status;
  if (Array.isArray(item.receiver_thread_ids)) input.receiver_thread_ids = item.receiver_thread_ids;
  const agentStates = asObject(item.agents_states);
  if (agentStates) input.agents_states = agentStates;
  return input;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function normalizeCodexSubagentStatus(
  rawStatus: string | undefined,
  fallback: UnifiedSubagentStatus,
): UnifiedSubagentStatus {
  if (!rawStatus) return fallback;
  switch (rawStatus) {
    case 'pending_init':
      return 'pending';
    case 'completed':
      return 'completed';
    case 'in_progress':
    case 'running':
      return 'running';
    default:
      break;
  }

  const lower = rawStatus.toLowerCase();
  if (lower.includes('error') || lower.includes('fail') || lower.includes('cancel')) {
    return 'error';
  }
  if (lower.includes('pending')) return 'pending';
  if (lower.includes('run') || lower.includes('progress')) return 'running';
  return fallback;
}

function formatCodexSubagentMessage(
  toolName: string,
  rawStatus: string | undefined,
  message: string | undefined,
): string | undefined {
  if (message) return message;
  if (rawStatus === 'pending_init') return 'Pending initialization';

  const lower = rawStatus?.toLowerCase();
  if (lower) {
    if (lower.includes('error') || lower.includes('fail') || lower.includes('cancel')) {
      return 'Error';
    }
    if (lower.includes('pending')) return 'Pending';
  }

  if (rawStatus === 'in_progress' || rawStatus === 'running') {
    switch (toolName) {
      case 'spawn_agent':
        return 'Starting';
      case 'wait':
        return 'Waiting';
      case 'send_input':
        return 'Sending follow-up';
      default:
        return 'Running';
    }
  }

  return undefined;
}

/** Completed collab calls have one representation: canonical child states, not a second tool.use. */
function collabSubagentEvents(item: Record<string, unknown>): UnifiedAgentEvent[] {
  const toolName = asString(item.tool) ?? '';
  const operation = SUBAGENT_OPERATIONS.get(toolName);
  if (!operation) {
    return [{ type: 'tool.use', name: toolName || 'collab_tool', input: collabToolInput(item) }];
  }

  const childIds = new Set(asStringArray(item.receiver_thread_ids));
  const agentStates = Array.isArray(item.agents_states) ? null : asObject(item.agents_states);
  if (agentStates) {
    // A malformed entry is not evidence of a child; receiver IDs can still identify it.
    for (const [id, state] of Object.entries(agentStates)) {
      if (asObject(state) && !Array.isArray(state)) childIds.add(id);
    }
  }
  // A failed/partial call may identify no child. Keep the attempted tool visible
  // to restricted consumers; there is no child state to emit alongside it.
  if (childIds.size === 0) {
    return [{ type: 'tool.use', name: toolName, input: collabToolInput(item), phase: 'completed' }];
  }
  const parentId = asString(item.sender_thread_id);
  const operationId = asString(item.id);
  const prompt = asString(item.prompt)?.trim();
  const description =
    operation === 'spawn'
      ? prompt
        ? `[Codex Agent] ${prompt}`
        : 'Running Codex sub-agent...'
      : `Running ${toolName}...`;
  const fallbackStatus: UnifiedSubagentStatus = operation === 'spawn' ? 'pending' : 'running';

  return [...childIds].map((id) => {
    const state = asObject(agentStates?.[id]);
    const rawStatus = asString(state?.status);
    const message = formatCodexSubagentMessage(
      toolName,
      rawStatus,
      asString(state?.message)?.trim(),
    );
    return {
      type: 'subagent.state',
      id,
      operation,
      ...(operationId ? { operationId } : {}),
      status: normalizeCodexSubagentStatus(rawStatus, fallbackStatus),
      ...(parentId ? { parentId } : {}),
      ...(rawStatus ? { rawStatus } : {}),
      description,
      ...(message ? { message } : {}),
    };
  });
}

// Exec reports session totals, not the last request's context (16M vs 244K in the
// 2026-09-22 incident). Keep that scope explicit. Guard: usage.test.ts aggregate meter.
export function parseCodex(json: unknown): UnifiedAgentEvent[] {
  const obj = asObject(json);
  if (!obj) return [{ type: 'error', message: 'Codex emitted non-object JSON' }];
  const type = asString(obj.type);
  if (!type) return [];

  switch (type) {
    case 'thread.started':
      return [{ type: 'progress', source: 'codex.thread_started' }];
    case 'turn.started':
      return [{ type: 'turn.started' }];
    case 'turn.completed': {
      const u = asObject(obj.usage);
      return [
        ...(u
          ? [
              {
                type: 'usage' as const,
                usage: {
                  t: 'total' as const,
                  // OpenAI has no separate write charge. Preserve an unexpected native write
                  // count as unreported, never erase it. Output includes reasoning tokens.
                  tokens: tokenUsage(
                    asNumber(u.input_tokens) === undefined ||
                      asNumber(u.cached_input_tokens) === undefined
                      ? undefined
                      : (u.input_tokens as number) - (u.cached_input_tokens as number),
                    asNumber(u.output_tokens),
                    asNumber(u.cached_input_tokens),
                    asNumber(u.cache_write_input_tokens) ?? 0,
                  ),
                },
              },
            ]
          : []),
        { type: 'turn.complete', reason: 'success' },
      ];
    }
    case 'turn.failed': {
      const raw = obj.error;
      return failureEvents(
        asString(raw) ?? asString(asObject(raw)?.message) ?? JSON.stringify(raw ?? 'Unknown error'),
      );
    }
    case 'error':
      return failureEvents(asString(obj.message) ?? JSON.stringify(obj), false);
    case 'item.started': {
      const item = asObject(obj.item);
      if (asString(item?.type) === 'command_execution' && asString(item?.command)) {
        const command = asString(item!.command)!;
        return [
          { type: 'tool.use', name: 'shell', input: { command }, displayText: `${command}\n` },
        ];
      }
      if (asString(item?.type) === 'collab_tool_call') {
        const name = asString(item?.tool) ?? 'collab_tool';
        return [
          {
            type: 'tool.use',
            name,
            input: collabToolInput(item!),
            ...(SUBAGENT_OPERATIONS.has(name) ? { phase: 'started' as const } : {}),
          },
        ];
      }
      return [
        {
          type: 'progress',
          source: 'codex.item_started',
          data: { itemType: asString(item?.type) ?? 'unknown' },
        },
      ];
    }
    case 'item.completed': {
      const item = asObject(obj.item);
      const itemType = asString(item?.type);
      if (!itemType)
        return [
          { type: 'progress', source: 'codex.item_completed', data: { itemType: 'unknown' } },
        ];
      if (itemType === 'agent_message' && asString(item?.text)) {
        return [{ type: 'text.delta', text: asString(item!.text)! }];
      }
      if (itemType === 'command_execution') {
        const input: Record<string, unknown> = { command: asString(item?.command) ?? '' };
        if (typeof item?.exit_code === 'number') input.exit_code = item.exit_code;
        return [{ type: 'tool.use', name: 'shell', input }];
      }
      if (itemType === 'file_change') {
        return [
          {
            type: 'tool.use',
            name: 'file_change',
            input: { changes: Array.isArray(item?.changes) ? item.changes : [] },
          },
        ];
      }
      if (itemType === 'mcp_tool_call') {
        return [
          { type: 'tool.use', name: asString(item?.name) ?? 'mcp_tool', input: {} },
          {
            type: 'tool.result',
            output: item?.result,
            isError: !!item?.error || item?.status === 'failed',
          },
        ];
      }
      if (itemType === 'web_search') {
        return [{ type: 'tool.use', name: 'web_search', input: {} }];
      }
      if (itemType === 'collab_tool_call') {
        return collabSubagentEvents(item!);
      }
      return [{ type: 'progress', source: 'codex.item_completed', data: { itemType } }];
    }
    default:
      return [{ type: 'progress', source: `codex.${type}` }];
  }
}
