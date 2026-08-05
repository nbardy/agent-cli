import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexNativeProgressProbe } from '../src/native-progress.ts';

test('Codex native progress uses rollout metadata without reading its contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-native-progress-'));
  const sessionId = '12345678-1234-4234-8234-123456789abc';
  const day = path.join(root, '2026', '08', '04');
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-08-04T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(rollout, 'private-reasoning-must-not-be-read\n');

  let now = 1_000;
  const probe = createCodexNativeProgressProbe(sessionId, {
    sessionsRoot: root,
    now: () => now,
  });

  assert.deepEqual(probe.poll(), {
    available: true,
    advanced: false,
    silentSeconds: 0,
    sizeBytes: 35,
  });

  now = 31_000;
  fs.appendFileSync(rollout, 'more-private-content\n');
  assert.deepEqual(probe.poll(), {
    available: true,
    advanced: true,
    silentSeconds: 0,
    sizeBytes: 56,
  });

  now = 61_000;
  assert.deepEqual(probe.poll(), {
    available: true,
    advanced: false,
    silentSeconds: 30,
    sizeBytes: 56,
  });
});

test('Codex native progress reports unavailable without exposing a path or session id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-native-progress-missing-'));
  const progress = createCodexNativeProgressProbe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
    sessionsRoot: root,
    now: () => 10_000,
  }).poll();
  assert.deepEqual(progress, { available: false, advanced: false, silentSeconds: 0 });
});
