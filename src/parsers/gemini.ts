import { failureEvents } from '../diagnostics.ts';
import { asObject, asString } from '../json-utils.ts';
import type { UnifiedAgentEvent } from '../runtime-types.ts';

export function parseGemini(json: unknown): UnifiedAgentEvent[] {
  const obj = asObject(json);
  if (!obj) return [{ type: 'error', message: 'Gemini emitted non-object JSON' }];
  const type = asString(obj.type);
  if (!type) {
    return [{ type: 'error', message: `Gemini JSON missing required "type": ${JSON.stringify(obj)}` }];
  }

  if (type === 'init') return [{ type: 'turn.started' }];
  if (type === 'message') {
    const role = asString(obj.role);
    const content = asString(obj.content);
    return role === 'assistant' && content
      ? [{ type: 'text.delta', text: content }]
      : [{ type: 'progress', source: 'gemini.message', data: { role: role ?? 'unknown', hasContent: !!content } }];
  }
  if (type === 'error') {
    const message = asString(obj.message) ?? asString(obj.error) ?? JSON.stringify(obj);
    return asString(obj.severity) === 'warning'
      ? [{ type: 'progress', source: 'gemini.warning', data: { message } }]
      : [{ type: 'error', message }];
  }
  if (type === 'tool_use') {
    return [{ type: 'tool.use', name: asString(obj.tool_name) ?? 'tool', input: asObject(obj.parameters) ?? {} }];
  }
  if (type === 'tool_result') {
    const toolId = asString(obj.tool_id);
    return [{ type: 'progress', source: 'gemini.tool_result', data: { status: asString(obj.status) ?? 'unknown', ...(toolId ? { tool_id: toolId } : {}) } }];
  }
  if (type === 'result') {
    return asString(obj.status) === 'success'
      ? [{ type: 'turn.complete', reason: 'success' }]
      : failureEvents(
          asString(obj.error) ??
            asString(obj.message) ??
            `Gemini result failed: ${String(obj.status ?? 'unknown')}`
        );
  }

  return [{ type: 'error', message: `Gemini emitted unrecognized event type "${type}": ${JSON.stringify(obj)}` }];
}
