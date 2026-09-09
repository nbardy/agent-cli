import assert from 'node:assert/strict';
import test from 'node:test';
import { createParser } from '../src/parsers/index.ts';

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
