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

function usageOf(events: UnifiedAgentEvent[]): Extract<TurnUsage, { t: 'request' }>[] {
  return events
    .filter((e): e is Extract<UnifiedAgentEvent, { type: 'usage' }> => e.type === 'usage')
    .map((e) => e.usage)
    .filter((u) => u.t === 'request');
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
    'result still completes the turn',
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
 * REGRESSION 2026-09-22 (unleashd "16M tokens" meter bug): `codex exec
 * --json` `turn.completed` usage is the SESSION-CUMULATIVE total, not the
 * latest request's context, so it must not be reported as one -- the same rule
 * claude's turn-aggregate `result` usage follows above. Numbers from a real
 * gpt-6-astra session: stdout reported input 16,062,762 while the rollout
 * file's `last_token_usage` for the same moment was 244,247 on a 258,400
 * window. An old single-turn fixture (input 30,735) could not catch this,
 * because last and total coincide on the first request.
 */
test('codex turn.completed carries a session aggregate and must not report context', () => {
  const events = parseCodex({
    type: 'turn.completed',
    usage: {
      input_tokens: 16062762,
      cached_input_tokens: 15811968,
      output_tokens: 39152,
    },
  });
  assert.deepEqual(usageOf(events), [], 'cumulative usage is an aggregate, not a context size');
  assert.ok(
    events.some((e) => e.type === 'turn.complete'),
    'turn.completed still completes the turn',
  );
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
    'a tool-calls step must not complete the turn',
  );
});

test('a harness that reports no usage emits no usage event', () => {
  assert.deepEqual(usageOf(parseCodex({ type: 'turn.completed' })), []);
  assert.deepEqual(usageOf(parseOpenCode({ type: 'step_finish', part: { reason: 'stop' } })), []);
  assert.deepEqual(
    usageOf(createClaudeParser()({ type: 'assistant', message: { content: [] } })),
    [],
  );
});

// Native fields are the pricing authority: no cache-write tier may be guessed.
test('pricing classes table: Claude tiers, Codex inclusive input, and missing classes', () => {
  const claude = (usage: object) => createClaudeParser()({ type: 'assistant', message: { usage } });
  const base = {
    input_tokens: 2,
    output_tokens: 7,
    cache_read_input_tokens: 13,
    cache_creation_input_tokens: 11,
  };
  const cases = [
    {
      name: 'Claude mixed cache tiers',
      events: claude({
        ...base,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 8 },
      }),
      expected: {
        t: 'reported',
        input: 2,
        output: 7,
        cacheRead: 13,
        cacheWrite5m: 3,
        cacheWrite1h: 8,
      },
    },
    {
      name: 'Claude no writes needs no tier',
      events: claude({ ...base, cache_creation_input_tokens: 0 }),
      expected: {
        t: 'reported',
        input: 2,
        output: 7,
        cacheRead: 13,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
    },
    {
      name: 'Claude missing tiers',
      events: claude(base),
      expected: {
        t: 'unreported',
        why: 'Harness omitted cache-write tiers or their sum differs from cache creation',
      },
    },
    {
      name: 'Claude mismatched tiers',
      events: claude({
        ...base,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 1 },
      }),
      expected: {
        t: 'unreported',
        why: 'Harness omitted cache-write tiers or their sum differs from cache creation',
      },
    },
    {
      name: 'Codex session aggregate',
      events: parseCodex({
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 17 },
      }),
      expected: {
        t: 'reported',
        input: 70,
        output: 17,
        cacheRead: 30,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
    },
    {
      name: 'Codex omitted cache reads',
      events: parseCodex({
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 17 },
      }),
      expected: {
        t: 'unreported',
        why: 'Harness omitted input, output, cached read or cache write tokens',
      },
    },
  ];
  for (const c of cases) {
    const event = c.events.find((e) => e.type === 'usage');
    assert.ok(event?.type === 'usage', c.name);
    assert.deepEqual(event.usage.tokens, c.expected, c.name);
  }
});

test('Claude repeated assistant blocks count once; result totals carry tiers without context', () => {
  const parse = createClaudeParser();
  const row = { ...CLAUDE_ASSISTANT, message: { ...CLAUDE_ASSISTANT.message, id: 'msg-one' } };
  assert.equal(usageOf(parse(row)).length, 1);
  assert.equal(usageOf(parse(row)).length, 0);
  const usage = {
    ...row.message.usage,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20271 },
  };
  const event = parse({ type: 'result', subtype: 'success', usage }).find(
    (e) => e.type === 'usage',
  );
  assert.ok(event?.type === 'usage' && event.usage.t === 'total');
  assert.deepEqual(event.usage.tokens, {
    t: 'reported',
    input: 2,
    output: 4,
    cacheRead: 18531,
    cacheWrite5m: 0,
    cacheWrite1h: 20271,
  });
});
