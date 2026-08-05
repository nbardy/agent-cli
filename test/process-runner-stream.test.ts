import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { attachReadableStream } from '../src/process-runner.ts';

test('stdout attachment explicitly flows and drains the first JSONL chunk', async () => {
  const stream = new PassThrough();
  stream.pause();
  const chunks: string[] = [];
  const states: string[] = [];

  attachReadableStream(
    stream,
    (chunk) => chunks.push(chunk.toString()),
    (state) => states.push(`${state.event}:${String(state.readableFlowing)}`)
  );
  stream.write('{"type":"thread.started"}\n');
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(chunks, ['{"type":"thread.started"}\n']);
  assert.equal(stream.readableFlowing, true);
  assert.ok(states.some((state) => state.startsWith('attached:')));
  assert.ok(states.includes('resume:true'));
});
