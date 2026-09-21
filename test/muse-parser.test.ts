import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { createMuseParser } from '../src/parsers/muse.ts';
import type { UnifiedAgentEvent } from '../src/runtime-types.ts';

/**
 * Regression: muse repeats the whole final message in run.terminal.completed
 * after streaming it as run.output.delta chunks. Both were emitted as
 * text.delta, so every consumer that concatenates deltas rendered the answer
 * twice -- stock_trader's research fan-out got "PONGPONG", and unleashd's
 * conversation runtime (server/src/conversations/runtime.ts, a plain append
 * with no dedupe) duplicated every muse final message.
 *
 * The invariant being protected: text.delta events are NON-OVERLAPPING
 * increments, as they already are for every other harness.
 */

function textOf(events: UnifiedAgentEvent[]): string {
  return events
    .filter((e): e is Extract<UnifiedAgentEvent, { type: 'text.delta' }> => e.type === 'text.delta')
    .map((e) => e.text)
    .join('');
}

function feed(parser: ReturnType<typeof createMuseParser>, events: unknown[]): UnifiedAgentEvent[] {
  return events.flatMap((e) => parser(e));
}

test('terminal event does not repeat text already streamed as deltas', () => {
  const parser = createMuseParser();
  const out = feed(parser, [
    { payload_type: 'run.output.delta', payload: { text: 'PO' } },
    { payload_type: 'run.output.delta', payload: { text: 'NG' } },
    { payload_type: 'run.terminal.completed', payload: { text: 'PONG' } },
  ]);

  assert.equal(textOf(out), 'PONG', 'deltas must concatenate to the answer exactly once');

  const complete = out.find((e) => e.type === 'turn.complete');
  assert.ok(complete && complete.type === 'turn.complete');
  assert.equal(complete.reason, 'success');
  assert.equal(complete.text, 'PONG', 'the full message rides turn.complete, not a duplicate delta');
});

test('terminal event emits only the suffix the deltas did not carry', () => {
  const parser = createMuseParser();
  const out = feed(parser, [
    { payload_type: 'run.output.delta', payload: { text: 'partial' } },
    { payload_type: 'run.terminal.completed', payload: { text: 'partial and the rest' } },
  ]);

  assert.equal(textOf(out), 'partial and the rest');
});

test('a terminal-only turn still yields its text', () => {
  const parser = createMuseParser();
  const out = feed(parser, [
    { payload_type: 'run.terminal.completed', payload: { text: 'no deltas were sent' } },
  ]);

  assert.equal(textOf(out), 'no deltas were sent');
});

test('repeated content is not mistaken for a duplicate', () => {
  // The naive fix -- "drop the terminal delta when it equals the accumulated
  // text" -- silently HALVES this legitimate answer. Position and prefix, not
  // content equality, is what distinguishes the repeat.
  const parser = createMuseParser();
  const out = feed(parser, [
    { payload_type: 'run.output.delta', payload: { text: 'abc' } },
    { payload_type: 'run.terminal.completed', payload: { text: 'abcabc' } },
  ]);

  assert.equal(textOf(out), 'abcabc');
});

test('parser instances do not share state', () => {
  const first = createMuseParser();
  feed(first, [{ payload_type: 'run.output.delta', payload: { text: 'from the first turn' } }]);

  const second = createMuseParser();
  const out = feed(second, [
    { payload_type: 'run.terminal.completed', payload: { text: 'from the second turn' } },
  ]);

  assert.equal(textOf(out), 'from the second turn');
});

/**
 * Regression: every lifecycle record carrying an `operation` was emitted as a
 * `tool.use`, so unleashd's tool history filled with rows named
 * `model.meta.response` -- muse's own model-step bookkeeping -- and showed each
 * real tool twice, once from its intent and once from its result.
 *
 * The fixture is a real `muse exec --json` turn (Muse Code 1.3.0) that ran
 * three bash commands. Captured 2026-09-21; regenerate by running
 * `muse exec --json --model muse-spark-1.3` on a prompt that shells out.
 */
const FIXTURE = new URL('./fixtures/muse-1.3-three-bash-calls.jsonl', import.meta.url);

function parseFixture(): UnifiedAgentEvent[] {
  const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim());
  const parser = createMuseParser();
  return lines.flatMap((line) => parser(JSON.parse(line)));
}

test('a real muse turn yields one tool.use per tool call and no lifecycle rows', () => {
  const events = parseFixture();
  const toolUses = events.filter((e) => e.type === 'tool.use');

  assert.deepEqual(
    toolUses.map((e) => (e.type === 'tool.use' ? e.name : '')),
    ['bash', 'bash', 'bash'],
    'three bash calls must surface as exactly three tool.use events, named bare'
  );
  assert.equal(
    events.filter((e) => e.type === 'tool.result').length,
    3,
    'each call keeps its result'
  );
});

test('muse model steps are hidden progress, never tools', () => {
  const events = parseFixture();

  for (const event of events) {
    assert.ok(
      !(event.type === 'tool.use' && event.name.startsWith('model.')),
      `model bookkeeping must not render as a tool call: ${JSON.stringify(event)}`
    );
  }

  const modelSteps = events.filter(
    (e) => e.type === 'progress' && e.source === 'muse.model_step'
  );
  assert.equal(modelSteps.length, 4, 'the four model round-trips stay observable as progress');
});

test('an unmatched tool.result still reports the call', () => {
  // The dedupe consumes a started tool; a result with no start we ever saw must
  // NOT be swallowed, or the call vanishes from history entirely.
  const parser = createMuseParser();
  const out = feed(parser, [
    {
      payload_type: 'tool.result',
      payload: { text: 'output', correlation_facts: { tool_name: 'bash', outcome: 'success' } },
    },
  ]);

  assert.equal(out.filter((e) => e.type === 'tool.use').length, 1);
  assert.equal(out.filter((e) => e.type === 'tool.result').length, 1);
});

test('a second call to the same tool is not silently deduped', () => {
  // Counting, not a boolean: two starts of `bash` must consume two results.
  const started = {
    payload_type: 'task.lifecycle.side_effect_intent',
    payload: { event: { operation: 'tool:bash' } },
  };
  const finished = (text: string) => ({
    payload_type: 'tool.result',
    payload: { text, correlation_facts: { tool_name: 'bash' } },
  });

  const parser = createMuseParser();
  const out = feed(parser, [started, started, finished('a'), finished('b')]);

  assert.equal(out.filter((e) => e.type === 'tool.use').length, 2, 'two calls, two rows');
  assert.equal(out.filter((e) => e.type === 'tool.result').length, 2);
});
