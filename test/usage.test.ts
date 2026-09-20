import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeParser } from '../src/parsers/claude.ts';
import { parseCodex } from '../src/parsers/codex.ts';
import { parseOpenCode } from '../src/parsers/opencode.ts';
import type { TurnUsage, UnifiedAgentEvent } from '../src/runtime-types.ts';

/**
 * Every harness reports token usage in its own convention, and picking the
 * wrong field is silent -- the number still looks plausible, it is just wrong
 * by a factor of two to fifty. These tests pin each convention to numbers
 * captured from the real CLIs (provenance noted per fixture), so a later
 * "simplification" to the obvious-looking field fails here instead of shipping
 * a context meter that lies.
 */

function usageOf(events: UnifiedAgentEvent[]): TurnUsage[] {
  return events
    .filter((e): e is Extract<UnifiedAgentEvent, { type: 'usage' }> => e.type === 'usage')
    .map((e) => e.usage);
}

/**
 * Captured from claude 2.1.267, `-p --output-format stream-json`, on a
 * one-word prompt. Note input_tokens: 2 -- the other 38,802 tokens of context
 * (Claude Code's own system prompt and tool schemas) are under the two cache
 * fields. Reading input_tokens alone reports 2 for a 38,804-token context.
 */
const CLAUDE_ASSISTANT = {
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 20271,
      cache_read_input_tokens: 18531,
      output_tokens: 4,
    },
  },
};

test('claude context is the sum of input and both cache fields', () => {
  const [usage] = usageOf(createClaudeParser()(CLAUDE_ASSISTANT));
  assert.ok(usage, 'assistant message must report usage');
  assert.equal(usage.contextTokens, 38_804);
  assert.equal(usage.cachedInputTokens, 18_531);
  assert.equal(usage.cacheWriteTokens, 20_271);
  assert.equal(usage.outputTokens, 4);
});

/**
 * Regression: claude's `result` event carries a usage block too, but it is the
 * TURN AGGREGATE across every request the turn made. On a recorded six-step
 * run with subagents (manual_tests/runs/2026-04-17T10-30-40-994Z-raw-claude-
 * subagents) the result summed to 70,213 while the final request's real
 * context was 23,948 -- reading it as a context size overstates ~3x, and the
 * overstatement grows with turn length.
 */
test('claude result carries a turn aggregate and must not report context', () => {
  const events = createClaudeParser()({
    type: 'result',
    subtype: 'success',
    usage: {
      input_tokens: 5,
      cache_creation_input_tokens: 12097,
      cache_read_input_tokens: 58111,
      output_tokens: 789,
    },
  });
  assert.deepEqual(usageOf(events), [], 'result usage is an aggregate, not a context size');
  assert.ok(
    events.some((e) => e.type === 'turn.complete'),
    'result still completes the turn'
  );
});

/**
 * A subagent's assistant message measures the SUBAGENT's context, not this
 * thread's. The recorded run above interleaved six of them with six main-thread
 * messages, so an unfiltered reader flips between two unrelated context sizes.
 */
test('claude subagent usage is not the parent thread context', () => {
  const events = createClaudeParser()({
    type: 'assistant',
    parent_tool_use_id: 'toolu_01Jed1Q2dvV1tL',
    message: {
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 13477,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
  });
  assert.deepEqual(usageOf(events), []);
});

/**
 * Captured from `codex exec --json`
 * (manual_tests/runs/prefix-smoke/stdout.log). Codex reports ONE input total
 * with the cached portion as a SUBSET of it -- the opposite of claude. Adding
 * them gives 60,815 for a 30,735-token context.
 */
test('codex context is input_tokens alone, cache already included', () => {
  const [usage] = usageOf(
    parseCodex({
      type: 'turn.completed',
      usage: { input_tokens: 30735, cached_input_tokens: 30080, output_tokens: 37 },
    })
  );
  assert.ok(usage, 'turn.completed must report usage');
  assert.equal(usage.contextTokens, 30_735);
  assert.equal(usage.cachedInputTokens, 30_080);
});

test('codex usage does not replace the turn completion', () => {
  const events = parseCodex({
    type: 'turn.completed',
    usage: { input_tokens: 997035, cached_input_tokens: 920832, output_tokens: 21624 },
  });
  assert.equal(usageOf(events).length, 1);
  assert.ok(events.some((e) => e.type === 'turn.complete'));
});

/**
 * Captured from `opencode run --format json` on opencode 1.18.18. Its own
 * `total` (15,292) folds in output and reasoning, so it is not a context size;
 * input (13,497) excludes cache hits, so it is not one either. Context is
 * input + cache.read + cache.write = 15,289.
 */
const OPENCODE_STEP_FINISH = {
  type: 'step_finish',
  part: {
    type: 'step-finish',
    reason: 'stop',
    tokens: {
      total: 15292,
      input: 13497,
      output: 3,
      reasoning: 0,
      cache: { write: 0, read: 1792 },
    },
  },
};

test('opencode context adds cache back to input and ignores its total', () => {
  const [usage] = usageOf(parseOpenCode(OPENCODE_STEP_FINISH));
  assert.ok(usage, 'step_finish must report usage');
  assert.equal(usage.contextTokens, 15_289);
  assert.notEqual(usage.contextTokens, 15_292);
  assert.equal(usage.cachedInputTokens, 1_792);
});

/**
 * A tool-calls step ends no turn but is still a model request, and it is where
 * the context actually grows -- dropping its usage means the meter only moves
 * on the last step of a turn.
 */
test('opencode reports usage on mid-turn tool-call steps', () => {
  const events = parseOpenCode({
    ...OPENCODE_STEP_FINISH,
    part: { ...OPENCODE_STEP_FINISH.part, reason: 'tool_calls' },
  });
  assert.equal(usageOf(events).length, 1);
  assert.ok(
    !events.some((e) => e.type === 'turn.complete'),
    'a tool-calls step must not complete the turn'
  );
});

test('a harness that reports no usage emits no usage event', () => {
  assert.deepEqual(usageOf(parseCodex({ type: 'turn.completed' })), []);
  assert.deepEqual(usageOf(parseOpenCode({ type: 'step_finish', part: { reason: 'stop' } })), []);
  assert.deepEqual(
    usageOf(createClaudeParser()({ type: 'assistant', message: { content: [] } })),
    []
  );
});
