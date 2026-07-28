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

    if (type === 'tool_call') return [];
    return [
      {
        type: 'error',
        message: `Cursor emitted unrecognized event type "${type}": ${JSON.stringify(obj)}`,
      },
    ];
  };
}
