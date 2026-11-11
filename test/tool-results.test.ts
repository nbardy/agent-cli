import assert from 'node:assert/strict';
import test from 'node:test';
import { createParser } from '../src/parsers/index.ts';

test('the run-3 Codex stream completes with its last agent_message, keeping progress as UI deltas', () => {
  const parse = createParser('codex');
  const progress = 'I’ll read the repository instructions, update the greeting, run the test, and commit on the assigned branch.';
  const answer = '{"summary":"Committed aa76f2cbe57df8a56629bdefc8d7d189790586eb","files":[]}';
  assert.deepEqual(parse({ type: 'item.completed', item: { type: 'agent_message', text: progress } }), [{ type: 'text.delta', text: progress }]);
  // No tool boundary between these messages is needed to separate them.
  parse({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
  assert.deepEqual(parse({ type: 'turn.completed' }), [{ type: 'turn.complete', reason: 'success', text: answer }]);
});

test('Claude uses its result final even when progress and sub-agent messages precede it', () => {
  const parse = createParser('claude');
  parse({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working' } } });
  parse({ type: 'assistant', parent_tool_use_id: 'child', message: { content: [{ type: 'text', text: 'child answer' }] } });
  assert.deepEqual(parse({ type: 'result', subtype: 'success', result: '{"n":7}' }), [{ type: 'turn.complete', reason: 'success', text: '{"n":7}' }]);
});

for (const harness of ['gemini', 'opencode', 'cursor', 'pi', 'muse'] as const) {
  test(`${harness} completion separates the final message from text before tools`, () => {
    const parse = createParser(harness);
    const records: Record<typeof harness, unknown[]> = {
      gemini: [
        { type: 'message', role: 'assistant', content: 'working' },
        { type: 'tool_use', tool_name: 'read' },
        { type: 'message', role: 'assistant', content: '{"n":7}' },
        { type: 'result', status: 'success' },
      ],
      opencode: [
        { type: 'text', part: { text: 'working' } },
        { type: 'step_start' },
        { type: 'text', part: { text: '{"n":7}' } },
        { type: 'step_finish', part: { reason: 'stop' } },
      ],
      cursor: [
        { type: 'assistant', message: { content: 'working' } },
        { type: 'assistant', message: { content: '{"n":7}' } },
        { type: 'result', subtype: 'success' },
      ],
      pi: [
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
        { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '{"n":7}' }] } },
        { type: 'agent_settled' },
      ],
      muse: [{ payload_type: 'run.terminal.completed', payload: { text: '{"n":7}' } }],
    };
    const events = records[harness].flatMap(parse);
    const completion = events.find((e) => e.type === 'turn.complete');
    assert.ok(completion?.type === 'turn.complete', JSON.stringify(events));
    assert.equal(completion.text, '{"n":7}');
  });
}

// Retained from the inline-Buddy-results branch: all four adapters must expose
// the actual tool result, including a failed tool's payload.
for (const failed of [false, true]) {
  const output = { content: [{ type: 'text', text: 'Saved result' }] };
  const cases = [
    ['codex', { type: 'item.completed', item: { type: 'mcp_tool_call', result: output, status: failed ? 'failed' : 'completed' } }],
    ['claude', { type: 'user', message: { content: [{ type: 'tool_result', content: output, is_error: failed }] } }],
    ['opencode', { type: 'tool_use', part: { tool: 'save', state: { status: failed ? 'error' : 'completed', output } } }],
    ['muse', { payload_type: 'tool.result', payload: { text: JSON.stringify(output), correlation_facts: { outcome: failed ? 'failed' : 'success' } } }],
  ] as const;
  for (const [provider, record] of cases) {
    test(`${provider} preserves tool completion payload and failure=${failed}`, () => {
      const event = createParser(provider)(record).find(event => event.type === 'tool.result');
      assert.ok(event?.type === 'tool.result');
      assert.equal(event.isError, failed);
      assert.deepEqual(typeof event.output === 'string' ? JSON.parse(event.output) : event.output, output);
    });
  }
}
