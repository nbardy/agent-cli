import { failureEvents } from '../diagnostics.ts';
import { asObject, asString } from '../json-utils.ts';
import type { UnifiedAgentEvent, UnifiedSubagentStatus } from '../runtime-types.ts';

const CODEX_COLLAB_TOOL_NAMES = new Set(['spawn_agent', 'wait', 'send_input']);

function collabToolInput(
  item: Record<string, unknown>,
  phase: 'started' | 'completed'
): Record<string, unknown> {
  const input: Record<string, unknown> = { _phase: phase };
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
  fallback: UnifiedSubagentStatus
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
  message: string | undefined
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

function collabSubagentEvents(
  item: Record<string, unknown>,
  phase: 'started' | 'completed'
): UnifiedAgentEvent[] {
  const toolName = asString(item.tool);
  if (phase !== 'completed' || !toolName || !CODEX_COLLAB_TOOL_NAMES.has(toolName)) return [];

  const childIds = new Set(asStringArray(item.receiver_thread_ids));
  const agentStates = asObject(item.agents_states);
  if (agentStates) {
    for (const threadId of Object.keys(agentStates)) childIds.add(threadId);
  }
  if (childIds.size === 0) return [];

  const parentId = asString(item.sender_thread_id);
  const description = asString(item.prompt);
  const fallbackStatus: UnifiedSubagentStatus = toolName === 'spawn_agent' ? 'pending' : 'running';

  return [...childIds].map((id) => {
    const state = asObject(agentStates?.[id]);
    const rawStatus = asString(state?.status);
    const message = formatCodexSubagentMessage(toolName, rawStatus, asString(state?.message));
    return {
      type: 'subagent.state',
      id,
      status: normalizeCodexSubagentStatus(rawStatus, fallbackStatus),
      ...(parentId ? { parentId } : {}),
      ...(rawStatus ? { rawStatus } : {}),
      ...(description ? { description } : {}),
      ...(message ? { message } : {}),
    };
  });
}

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
    case 'turn.completed':
      return [{ type: 'turn.complete', reason: 'success' }];
    case 'turn.failed': {
      const raw = obj.error;
      return failureEvents(
        asString(raw) ?? asString(asObject(raw)?.message) ?? JSON.stringify(raw ?? 'Unknown error')
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
        return [
          {
            type: 'tool.use',
            name: asString(item?.tool) ?? 'collab_tool',
            input: collabToolInput(item!, 'started'),
          },
          ...collabSubagentEvents(item!, 'started'),
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
        return [{ type: 'tool.use', name: asString(item?.name) ?? 'mcp_tool', input: {} }];
      }
      if (itemType === 'web_search') {
        return [{ type: 'tool.use', name: 'web_search', input: {} }];
      }
      if (itemType === 'collab_tool_call') {
        return [
          {
            type: 'tool.use',
            name: asString(item?.tool) ?? 'collab_tool',
            input: collabToolInput(item!, 'completed'),
          },
          ...collabSubagentEvents(item!, 'completed'),
        ];
      }
      return [{ type: 'progress', source: 'codex.item_completed', data: { itemType } }];
    }
    default:
      return [{ type: 'progress', source: `codex.${type}` }];
  }
}
