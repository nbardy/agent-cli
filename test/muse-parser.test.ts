import assert from 'node:assert/strict';
import test from 'node:test';

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
