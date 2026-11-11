import type { UnifiedAgentEvent } from '../runtime-types.ts';
import { asObject, asString } from '../json-utils.ts';
import type { Harness } from '../types.ts';
import { createClaudeParser } from './claude.ts';
import { parseCodex } from './codex.ts';
import { createCursorParser } from './cursor.ts';
import { parseGemini } from './gemini.ts';
import { createMuseParser } from './muse.ts';
import { createPiParser } from './pi.ts';
import { parseOpenCode } from './opencode.ts';

export type HarnessParser = (json: unknown) => UnifiedAgentEvent[];

export function createParser(harness: Harness): HarnessParser {
  return withFinalMessage(parserOf(harness), harness);
}

function parserOf(harness: Harness): HarnessParser {
  switch (harness) {
    case 'claude':
      return createClaudeParser();
    case 'codex':
      return parseCodex;
    case 'opencode':
      return parseOpenCode;
    case 'gemini':
      return parseGemini;
    case 'cursor':
      return createCursorParser();
    case 'pi':
      return createPiParser();
    case 'muse':
      return createMuseParser();
  }
}

// Run 3 bought a successful commit twice: progress was concatenated with Codex's bare JSON.
// Keep UI deltas intact, but give every completion the final message separately.
// Guard: tool-results.test.ts, final messages across tools and assistant message boundaries.
// Pattern: table-driven (docs/patterns.md#table-driven)
type RawMessage = Record<string, unknown>;
const assistantText = (obj: RawMessage): string | undefined => {
  const message = asObject(obj.message);
  const content = message?.content;
  if (Array.isArray(content)) return content.map((b) => {
    const block = asObject(b);
    return block?.type === 'text' ? asString(block.text) ?? '' : '';
  }).join('');
  return asString(content) ?? asString(message?.text) ?? asString(obj.content) ?? asString(obj.text);
};
const noSnapshot = (_obj: RawMessage): undefined => undefined;
/** Streaming harnesses use deltas since the last tool/model step; snapshots replace that buffer. */
const SNAPSHOT: Record<Harness, (obj: RawMessage) => string | undefined> = {
  claude: (obj) => {
    if (obj.type === 'result') return asString(obj.result);
    return obj.type === 'assistant' && obj.parent_tool_use_id == null ? assistantText(obj) : undefined;
  },
  codex: (obj) => {
    const item = asObject(obj.item);
    return obj.type === 'item.completed' && item?.type === 'agent_message' ? asString(item.text) : undefined;
  },
  cursor: (obj) => obj.type === 'assistant' ? assistantText(obj) : undefined,
  pi: (obj) => obj.type === 'message_end' && asObject(obj.message)?.role === 'assistant' ? assistantText(obj) : undefined,
  gemini: noSnapshot,
  opencode: noSnapshot,
  muse: noSnapshot, // Its terminal event already carries the final text.
};
function withFinalMessage(parse: HarnessParser, harness: Harness): HarnessParser {
  let text = '';
  return (json) => {
    const obj = asObject(json);
    const rawEvent = asObject(obj?.event);
    if (obj?.type === 'message_start' || rawEvent?.type === 'message_start') text = '';
    const events = parse(json);
    for (const event of events) {
      if (event.type === 'turn.started' || event.type === 'tool.use') text = '';
      if (event.type === 'text.delta') text += event.text;
    }
    if (obj) text = SNAPSHOT[harness](obj) ?? text;
    return events.map((event) => event.type === 'turn.complete'
      ? { ...event, text: event.text ?? text }
      : event);
  };
}
