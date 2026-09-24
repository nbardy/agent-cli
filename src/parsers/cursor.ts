import { CURSOR_MCP_PROVIDER_PREFIX } from '../cursor-mcp-plugin.ts';
import { failureEvents } from '../diagnostics.ts';
import { asObject, asString, normalizeType } from '../json-utils.ts';
import type { UnifiedAgentEvent } from '../runtime-types.ts';

function extractMessageText(obj: Record<string, unknown>): string | undefined {
  const direct = asString(obj.content) ?? asString(obj.text);
  if (direct) return direct;
  const message = asObject(obj.message);
  const messageText = asString(message?.text) ?? asString(message?.content);
  if (messageText) return messageText;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  const chunks = content
    .map((entry) => {
      const item = asObject(entry);
      return asString(item?.type) === 'text' ? asString(item?.text) : undefined;
    })
    .filter(Boolean);
  return chunks.length > 0 ? chunks.join('') : undefined;
}

function resultEvents(obj: Record<string, unknown>): UnifiedAgentEvent[] {
  if (
    normalizeType(asString(obj.subtype)) === 'success' ||
    asString(obj.status) === 'success' ||
    asString(obj.reason) === 'success' ||
    obj.is_error === false
  ) {
    return [{ type: 'turn.complete', reason: 'success' }];
  }
  return failureEvents(
    asString(obj.error) ??
      asString(obj.message) ??
      `Cursor result failed: ${String(obj.subtype ?? obj.status ?? obj.reason ?? 'unknown')}`
  );
}

/**
 * Current `agent` stream shape (2026.08.11): one `tool_call` record per phase,
 * `{ subtype: 'started' | 'completed', tool_call: { <kind>ToolCall: { args, result? } } }`
 * with exactly one `<kind>ToolCall` key (`shellToolCall`, `readToolCall`,
 * `mcpToolCall`, `getMcpToolsToolCall`, ...). `started` becomes tool.use,
 * `completed` becomes tool.result. MCP calls are renamed to the canonical
 * `mcp__<server>__<tool>` every other harness emits, stripping the plugin
 * prefix our own MCP injection adds (cursor-mcp-plugin.ts) so callers never
 * see Cursor's plugin naming.
 *
 * These were dropped wholesale before 2026-09-24, which left Cursor turns
 * with no visible tool activity and the memory reviewer's non-memory-tool
 * guard blind.
 */
function toolCallEvents(obj: Record<string, unknown>): UnifiedAgentEvent[] {
  const call = asObject(obj.tool_call);
  const [key, value] = Object.entries(call ?? {}).find(([name]) => name.endsWith('ToolCall')) ?? [];
  if (!key) return [];
  const body = asObject(value) ?? {};
  const args = asObject(body.args) ?? {};
  switch (normalizeType(asString(obj.subtype))) {
    case 'started':
      return [{ type: 'tool.use', name: toolName(key, args), input: toolInput(key, args) }];
    case 'completed': {
      const result = asObject(body.result) ?? {};
      const success = result.success;
      return [
        {
          type: 'tool.result',
          output: success ?? result,
          isError: success === undefined,
        },
      ];
    }
    default:
      return [];
  }
}

function toolName(key: string, args: Record<string, unknown>): string {
  if (key !== 'mcpToolCall') return key.slice(0, -'ToolCall'.length);
  const provider = asString(args.providerIdentifier) ?? 'mcp';
  const server = provider.startsWith(CURSOR_MCP_PROVIDER_PREFIX)
    ? provider.slice(CURSOR_MCP_PROVIDER_PREFIX.length)
    : provider;
  return `mcp__${server}__${asString(args.toolName) ?? 'tool'}`;
}

function toolInput(key: string, args: Record<string, unknown>): Record<string, unknown> {
  return key === 'mcpToolCall' ? (asObject(args.args) ?? {}) : args;
}

export function createCursorParser(): (json: unknown) => UnifiedAgentEvent[] {
  let lastAssistantText = '';

  return (json: unknown): UnifiedAgentEvent[] => {
    const obj = asObject(json);
    if (!obj) return [{ type: 'error', message: 'Cursor emitted non-object JSON' }];
    const type = asString(obj.type);
    if (!type) {
      return [
        { type: 'error', message: `Cursor JSON missing required "type": ${JSON.stringify(obj)}` },
      ];
    }

    if (type === 'system') {
      const subtype = normalizeType(asString(obj.subtype));
      if (subtype === 'init') {
        lastAssistantText = '';
        return [{ type: 'turn.started' }];
      }
      return [
        { type: 'progress', source: 'cursor.system', data: { subtype: subtype ?? 'unknown' } },
      ];
    }

    if (type === 'init' || type === 'turn.started') {
      lastAssistantText = '';
      return [{ type: 'turn.started' }];
    }

    if (type === 'assistant') {
      const content = extractMessageText(obj);
      if (!content) {
        return [
          {
            type: 'progress',
            source: 'cursor.message',
            data: { role: 'assistant', hasContent: false },
          },
        ];
      }
      if (content === lastAssistantText) return [];
      const delta =
        lastAssistantText && content.startsWith(lastAssistantText)
          ? content.slice(lastAssistantText.length)
          : content;
      lastAssistantText = content;
      return delta ? [{ type: 'text.delta', text: delta }] : [];
    }

    if (type === 'user') {
      return [
        {
          type: 'progress',
          source: 'cursor.message',
          data: { role: 'user', hasContent: !!extractMessageText(obj) },
        },
      ];
    }

    if (type === 'message' || type === 'text.delta') {
      const role = asString(obj.role);
      const content = extractMessageText(obj);
      if ((type === 'text.delta' || !role || role === 'assistant') && content) {
        return [{ type: 'text.delta', text: content }];
      }
      return [
        {
          type: 'progress',
          source: 'cursor.message',
          data: { role: role ?? 'unknown', hasContent: !!content },
        },
      ];
    }

    if (type === 'error') {
      const message = asString(obj.message) ?? asString(obj.error) ?? JSON.stringify(obj);
      return asString(obj.severity) === 'warning'
        ? [{ type: 'progress', source: 'cursor.warning', data: { message } }]
        : [{ type: 'error', message }];
    }

    if (type === 'tool_use' || type === 'tool') {
      return [
        {
          type: 'tool.use',
          name: asString(obj.tool_name) ?? asString(obj.name) ?? 'tool',
          input: asObject(obj.parameters) ?? asObject(obj.input) ?? {},
        },
      ];
    }

    if (type === 'tool_result') {
      const toolId = asString(obj.tool_id);
      return [
        {
          type: 'progress',
          source: 'cursor.tool_result',
          data: {
            status: asString(obj.status) ?? 'unknown',
            ...(toolId ? { tool_id: toolId } : {}),
          },
        },
      ];
    }

    if (type === 'result' || type === 'turn.complete') {
      lastAssistantText = '';
      return resultEvents(obj);
    }

    if (type === 'tool_call') return toolCallEvents(obj);
    // Reasoning models (grok-4.7, 2026-09-24) stream `thinking` delta/completed
    // records. They used to fall through to "unrecognized event type" errors,
    // which failed every such turn and the memory reviewer on its first step.
    if (type === 'thinking') {
      return [
        {
          type: 'progress',
          source: 'cursor.thinking',
          data: { subtype: normalizeType(asString(obj.subtype)) ?? 'unknown' },
        },
      ];
    }
    return [
      {
        type: 'error',
        message: `Cursor emitted unrecognized event type "${type}": ${JSON.stringify(obj)}`,
      },
    ];
  };
}
