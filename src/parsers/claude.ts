import { failureEvents } from '../diagnostics.ts';
import { asNumber, asObject, asString } from '../json-utils.ts';
import type { UnifiedAgentEvent } from '../runtime-types.ts';

/**
 * Claude splits one request's input across three fields, so the context size
 * is their SUM. `input_tokens` alone is only the uncached remainder: measured
 * against claude 2.1.267 a 38,804-token prompt reported `input_tokens: 2` with
 * the other 38,802 under cache_read/cache_creation.
 */
function claudeUsageEvents(rawUsage: unknown): UnifiedAgentEvent[] {
  const usage = asObject(rawUsage);
  if (!usage) return [];
  const input = asNumber(usage.input_tokens);
  const cacheRead = asNumber(usage.cache_read_input_tokens);
  const cacheWrite = asNumber(usage.cache_creation_input_tokens);
  if (input === undefined && cacheRead === undefined && cacheWrite === undefined) return [];
  return [
    {
      type: 'usage',
      usage: {
        contextTokens: (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
        outputTokens: asNumber(usage.output_tokens) ?? 0,
        ...(cacheRead === undefined ? {} : { cachedInputTokens: cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
      },
    },
  ];
}

/**
 * Claude's sub-agent spawn tool. Claude Code 2.1 renamed `Task` to `Agent`;
 * older sessions (and transcripts on disk) still carry `Task`, so both mean
 * "spawn a sub-agent". Consumers ask this set rather than matching a name.
 */
export const CLAUDE_SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['Agent', 'Task']);

/**
 * Background-task lifecycle, streamed live as `system` lines. `task_progress`,
 * `task_updated` and `background_tasks_changed` repeat what these two say, so
 * only the start and the terminal notification become events. A line missing
 * a field is reported on stderr rather than guessed at.
 */
function claudeTaskStarted(obj: Record<string, unknown>): UnifiedAgentEvent[] {
  const taskId = asString(obj.task_id);
  const toolUseId = asString(obj.tool_use_id);
  const description = asString(obj.description);
  if (!taskId || !toolUseId || description === undefined) {
    return [{ type: 'stderr', text: 'agent-cli: malformed claude task_started\n' }];
  }
  const background = obj.is_backgrounded === true;
  return [{ type: 'task.started', taskId, toolUseId, background, description }];
}

function claudeTaskFinished(obj: Record<string, unknown>): UnifiedAgentEvent[] {
  const taskId = asString(obj.task_id);
  const toolUseId = asString(obj.tool_use_id);
  const status = asString(obj.status);
  if (!taskId || !toolUseId || !status) {
    return [{ type: 'stderr', text: 'agent-cli: malformed claude task_notification\n' }];
  }
  return [{ type: 'task.finished', taskId, toolUseId, status }];
}

const CLAUDE_TASK_SUBTYPES = new Map<string, (obj: Record<string, unknown>) => UnifiedAgentEvent[]>([
  ['task_started', claudeTaskStarted],
  ['task_notification', claudeTaskFinished],
]);

export function createClaudeParser(): (json: unknown) => UnifiedAgentEvent[] {
  let pendingTool: { name: string; inputJson: string } | null = null;

  return (json: unknown): UnifiedAgentEvent[] => {
    const obj = asObject(json);
    if (!obj) return [{ type: 'error', message: 'Claude emitted non-object JSON' }];

    // Provider-generated conversation labels. Observed on disk in
    // ~/.claude/projects/<slug>/*.jsonl as {"type":"ai-title","aiTitle":"…"}
    // (auto, re-emitted per turn) and {"type":"custom-title","customTitle":"…"}
    // (user-set via /rename or --name). The server owns custom-over-ai
    // precedence; the event carries the raw observation verbatim.
    if (obj.type === 'ai-title') {
      const title = asString(obj.aiTitle)?.trim();
      return title ? [{ type: 'session.title', title, source: 'ai' }] : [];
    }
    if (obj.type === 'custom-title') {
      const title = asString(obj.customTitle)?.trim();
      return title ? [{ type: 'session.title', title, source: 'custom' }] : [];
    }

    if (obj.type === 'system' && asString(obj.subtype) === 'init') {
      return [{ type: 'turn.started' }];
    }
    const taskHandler = obj.type === 'system' ? CLAUDE_TASK_SUBTYPES.get(asString(obj.subtype) ?? '') : undefined;
    if (taskHandler) return taskHandler(obj);

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
        name === 'AskUserQuestion' || CLAUDE_SUBAGENT_TOOL_NAMES.has(name)
          ? { type: 'tool.use', name, input }
          : { type: 'tool.use', name, input, displayText: `${name}\n` },
      ];
    }

    if (obj.type === 'assistant') {
      // Usage rides the assistant message and ONLY the assistant message.
      // `result` carries a usage block too, but it is the turn AGGREGATE across
      // every request the turn made: on a recorded six-step run with subagents
      // it read 70,213 while the final request's real context was 23,948.
      // Reading it as a context size overstates by whatever the turn spent.
      // Subagent messages (parent_tool_use_id set) measure the SUBAGENT's own
      // context, not this thread's, so they are skipped for the same reason.
      const usageEvents =
        obj.parent_tool_use_id == null
          ? claudeUsageEvents(asObject(obj.message)?.usage)
          : [];
      const content = asObject(obj.message)?.content;
      if (!Array.isArray(content)) return usageEvents;
      for (const item of content) {
        const block = asObject(item);
        if (asString(block?.type) === 'tool_use' && asString(block?.name) === 'AskUserQuestion') {
          return [
            ...usageEvents,
            {
              type: 'text.delta',
              text: `\n<!--ask_user_question:${JSON.stringify(asObject(block?.input) ?? {})}-->\n`,
            },
          ];
        }
      }
      return usageEvents;
    }

    if (obj.type === 'user') {
      const content = asObject(obj.message)?.content;
      if (!Array.isArray(content)) return [];
      return content.flatMap((item): UnifiedAgentEvent[] => {
        const block = asObject(item);
        return block?.type === 'tool_result'
          ? [{ type: 'tool.result', output: block.content, isError: block.is_error === true }]
          : [];
      });
    }

    if (obj.type === 'result') {
      // Claude 2.1.282 reports a 429 session limit as subtype "success" with
      // is_error true, the message only on `result` (no text deltas). Reading
      // subtype alone made that an empty successful turn.
      const failed = asString(obj.subtype) !== 'success' || obj.is_error === true;
      return failed
        ? failureEvents(asString(obj.result) ?? 'Claude returned an error')
        : [{ type: 'turn.complete', reason: 'success' }];
    }

    return [];
  };
}
