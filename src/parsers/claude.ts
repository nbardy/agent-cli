import { failureEvents } from '../diagnostics.ts';
import { asObject, asString } from '../json-utils.ts';
import type { UnifiedAgentEvent } from '../runtime-types.ts';

export function createClaudeParser(): (json: unknown) => UnifiedAgentEvent[] {
  let pendingTool: { name: string; inputJson: string } | null = null;

  return (json: unknown): UnifiedAgentEvent[] => {
    const obj = asObject(json);
    if (!obj) return [{ type: 'error', message: 'Claude emitted non-object JSON' }];

    if (obj.type === 'system' && asString(obj.subtype) === 'init') {
      return [{ type: 'turn.started' }];
    }

    if (obj.type === 'stream_event') {
      const event = asObject(obj.event);
      const eventType = asString(event?.type);
      if (eventType === 'content_block_delta') {
        const delta = asObject(event?.delta);
        const deltaType = asString(delta?.type);
        if (deltaType === 'text_delta' && asString(delta?.text)) {
          return [{ type: 'text.delta', text: asString(delta!.text)! }];
        }
        if (deltaType === 'input_json_delta' && pendingTool) {
          pendingTool.inputJson += asString(delta?.partial_json) ?? '';
        }
        return [];
      }

      if (eventType === 'content_block_start') {
        const block = asObject(event?.content_block);
        if (asString(block?.type) === 'tool_use') {
          pendingTool = { name: asString(block?.name) ?? 'tool', inputJson: '' };
        }
        return [];
      }

      if (eventType !== 'content_block_stop' || !pendingTool) return [];
      const { name, inputJson } = pendingTool;
      pendingTool = null;
      let input: Record<string, unknown> = {};
      if (inputJson) {
        try {
          input = JSON.parse(inputJson) as Record<string, unknown>;
        } catch {}
      }
      return [
        name === 'AskUserQuestion' || name === 'Task'
          ? { type: 'tool.use', name, input }
          : { type: 'tool.use', name, input, displayText: `${name}\n` },
      ];
    }

    if (obj.type === 'assistant') {
      const content = asObject(obj.message)?.content;
      if (!Array.isArray(content)) return [];
      for (const item of content) {
        const block = asObject(item);
        if (asString(block?.type) === 'tool_use' && asString(block?.name) === 'AskUserQuestion') {
          return [
            {
              type: 'text.delta',
              text: `\n<!--ask_user_question:${JSON.stringify(asObject(block?.input) ?? {})}-->\n`,
            },
          ];
        }
      }
      return [];
    }

    if (obj.type === 'result') {
      return asString(obj.subtype) === 'success'
        ? [{ type: 'turn.complete', reason: 'success' }]
        : failureEvents(asString(obj.result) ?? 'Claude returned an error');
    }

    return [];
  };
}
