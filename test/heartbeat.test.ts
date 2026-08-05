import assert from 'node:assert/strict';
import test from 'node:test';

import { createHeartbeat } from '../src/heartbeat.ts';
import type { UnifiedAgentEvent } from '../src/runtime-types.ts';

test('heartbeat starts before parsed content and survives long silent reasoning', () => {
  let now = 0;
  let tick: () => void = () => {
    throw new Error('heartbeat timer was not scheduled');
  };
  let scheduled = false;
  let cleared = false;
  const events: UnifiedAgentEvent[] = [];
  const fakeTimer = {} as ReturnType<typeof setInterval>;
  const heartbeat = createHeartbeat(true, (event) => events.push(event), {
    now: () => now,
    checkIntervalMs: 30_000,
    silenceThresholdMs: 25_000,
    nativeProgress: () => ({
      available: true,
      advanced: true,
      silentSeconds: 0,
      sizeBytes: 1234,
    }),
    stdoutState: () => ({ event: 'resume', readableFlowing: true, readableLength: 0 }),
    setIntervalFn(callback) {
      tick = callback;
      scheduled = true;
      return fakeTimer;
    },
    clearIntervalFn(timer) {
      assert.equal(timer, fakeTimer);
      cleared = true;
    },
  });

  heartbeat.start();
  assert.equal(scheduled, true);

  now = 30_000;
  tick();
  assert.deepEqual(events[0], {
    type: 'progress',
    source: 'agent-cli.heartbeat',
    data: {
      unifiedEventSilentSeconds: 30,
      rawStdoutSilentSeconds: 30,
      phase: 'startup',
      stdoutStreamEvent: 'resume',
      stdoutReadableFlowing: true,
      stdoutReadableLengthBytes: 0,
      nativeSessionAvailable: true,
      nativeSessionAdvanced: true,
      nativeSessionSilentSeconds: 0,
      nativeSessionSizeBytes: 1234,
    },
  });

  // Raw-but-unparsed output must not suppress the bridge heartbeat.
  now = 40_000;
  heartbeat.markStdout();
  now = 60_000;
  tick();
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], {
    type: 'progress',
    source: 'agent-cli.heartbeat',
    data: {
      unifiedEventSilentSeconds: 60,
      rawStdoutSilentSeconds: 20,
      phase: 'startup',
      stdoutStreamEvent: 'resume',
      stdoutReadableFlowing: true,
      stdoutReadableLengthBytes: 0,
      nativeSessionAvailable: true,
      nativeSessionAdvanced: true,
      nativeSessionSilentSeconds: 0,
      nativeSessionSizeBytes: 1234,
    },
  });

  heartbeat.markMeaningful();
  heartbeat.markUnifiedEvent();
  now = 70_000;
  tick();
  assert.equal(events.length, 2);

  // The old implementation stopped after twenty minutes of stdout silence.
  // A live child now remains observable until its owner stops it or applies the
  // independent hard runtime cap.
  now = 21 * 60_000;
  tick();
  assert.equal(events.length, 3);
  assert.equal(events[2].type, 'progress');
  if (events[2].type === 'progress') assert.equal(events[2].data?.phase, 'running');

  heartbeat.stop();
  assert.equal(cleared, true);
});

test('heartbeat remains disabled for single-shot mode', () => {
  let scheduled = false;
  const heartbeat = createHeartbeat(false, () => {}, {
    setIntervalFn() {
      scheduled = true;
      return {} as ReturnType<typeof setInterval>;
    },
  });
  heartbeat.start();
  assert.equal(scheduled, false);
});
