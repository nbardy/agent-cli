import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { attachExecution } from '../src/execute.ts';
import { executionState, isAlive } from '../src/journal.ts';
import type { UnifiedAgentEvent } from '../src/runtime-types.ts';

// The property the journal exists for: an execution outlives the process that
// spawned it and is adopted, in order, by another. Before 2026-09-30 the CLI's
// stdout was a pipe to the spawner, so SIGKILLing a backend killed every turn
// (agent_notes/2026-09-30_backend-death-drops-workers.md).

// A claude-shaped CLI: `before`, then waits for a release file, then `after`.
// `hang` never finishes on its own.
const SHIM = `#!/usr/bin/env node
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const text = (t) => say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
  say({ type: 'system', subtype: 'init', session_id: 'journal-session' });
  text('before;');
  const release = process.env.JOURNAL_RELEASE;
  const wait = setInterval(() => {
    if (prompt.trim() === 'hang' || !fs.existsSync(release)) return;
    clearInterval(wait);
    text('after;');
    say({ type: 'result', subtype: 'success' });
    process.exit(0);
  }, 20);
});
`;

describe('journaled executions survive their spawner', { concurrency: false }, () => {
  let root: string;
  const originalPath = process.env.PATH ?? '';

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'agent-cli-journal-'));
    const shim = path.join(root, 'claude');
    writeFileSync(shim, SHIM);
    chmodSync(shim, 0o755);
    process.env.PATH = `${root}:${originalPath}`;
  });
  after(() => {
    process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  /** A throwaway "backend": spawns one execution into `dir`, prints its pid, then idles. */
  async function spawnFromDoomedParent(dir: string, prompt: string, release: string) {
    const executeUrl = new URL('../src/execute.ts', import.meta.url).href;
    const parent = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `const { executeCommand } = await import(${JSON.stringify(executeUrl)});
         const turn = executeCommand({ harness: 'claude', mode: 'conversation', prompt: ${JSON.stringify(prompt)},
           cwd: ${JSON.stringify(root)}, journalDir: ${JSON.stringify(dir)} });
         for await (const event of turn.events) process.stdout.write(JSON.stringify(event) + '\\n');`,
      ],
      { env: { ...process.env, JOURNAL_RELEASE: release }, stdio: ['ignore', 'pipe', 'inherit'] }
    );
    let seen = '';
    await new Promise<void>((resolve, reject) => {
      parent.stdout.on('data', (chunk) => {
        seen += chunk;
        if (seen.includes('before;')) resolve();
      });
      parent.on('exit', () => reject(new Error(`spawner exited early: ${seen}`)));
    });
    const pid = Number(readFileSync(path.join(dir, 'pid'), 'utf8'));
    parent.kill('SIGKILL');
    await new Promise((resolve) => parent.once('close', resolve));
    return pid;
  }

  async function collect(events: AsyncIterable<UnifiedAgentEvent>) {
    const all: UnifiedAgentEvent[] = [];
    for await (const event of events) all.push(event);
    return all;
  }

  it('a SIGKILLed spawner leaves the turn running; an adopter replays and follows it in order', async () => {
    const dir = path.join(root, 'adopt');
    const release = path.join(root, 'release-adopt');
    const pid = await spawnFromDoomedParent(dir, 'go', release);

    // The spawner is dead; the execution is not.
    assert.deepEqual(executionState(dir), { kind: 'running', pid });
    const adopted = attachExecution(dir);
    assert.equal(adopted.pid, pid, 'the adopter follows the same process, not a new one');
    const events = collect(adopted.events);
    writeFileSync(release, '');
    const completion = await adopted.completed;
    const texts = (await events).flatMap((e) => (e.type === 'text.delta' ? [e.text] : []));

    assert.deepEqual(texts, ['before;', 'after;'], 'output before and after the spawner died, once each, in order');
    assert.equal(completion.reason, 'success');
    assert.equal(completion.exitCode, 0);
    assert.equal(completion.lost, false);
    assert.equal(completion.sessionId, 'journal-session');
    assert.equal(executionState(dir).kind, 'exited');
  });

  it('stop from an adopter kills the group and reads as killed, not lost', async () => {
    const dir = path.join(root, 'stop');
    const pid = await spawnFromDoomedParent(dir, 'hang', path.join(root, 'never'));
    const adopted = attachExecution(dir);
    const events = collect(adopted.events);
    adopted.stop();
    const completion = await adopted.completed;
    await events;

    assert.equal(completion.reason, 'killed');
    assert.equal(completion.lost, false, 'the wrapper recorded the stop');
    assert.equal(completion.signal, 'SIGTERM');
    assert.equal(isAlive(pid), false);
  });

  it('a group SIGKILLed from outside is lost: never success, and says so', async () => {
    const dir = path.join(root, 'lost');
    const pid = await spawnFromDoomedParent(dir, 'hang', path.join(root, 'never'));
    const adopted = attachExecution(dir);
    const events = collect(adopted.events);
    process.kill(-pid, 'SIGKILL');
    const completion = await adopted.completed;
    const errors = (await events).flatMap((e) => (e.type === 'error' ? [e.message] : []));

    assert.equal(completion.lost, true);
    assert.equal(completion.reason, 'killed');
    assert.ok(errors.some((m) => /execution was lost/.test(m)), errors.join(' | '));
    assert.equal(existsSync(path.join(dir, 'exit.json')), false);
    assert.equal(executionState(dir).kind, 'lost');
  });

  // Review of P1 (2026-10-01): liveness was `kill(pid, 0)` and stop signalled `-pid`, so a
  // lost wrapper whose pid the OS reused read as running forever, and stop killed the
  // unrelated group that now owns the pid. Both now require the pid to still be our wrapper.
  it('a lost wrapper whose pid was reused: reads as lost, and stop never signals the new owner', async () => {
    const dir = path.join(root, 'reused');
    const pid = await spawnFromDoomedParent(dir, 'hang', path.join(root, 'never'));
    process.kill(-pid, 'SIGKILL');
    while (isAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 20));
    const stranger = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
    try {
      writeFileSync(path.join(dir, 'pid'), String(stranger.pid));
      assert.equal(executionState(dir).kind, 'lost');
      const adopted = attachExecution(dir);
      const events = collect(adopted.events);
      adopted.stop();
      const completion = await adopted.completed;
      await events;

      assert.equal(completion.lost, true);
      assert.equal(isAlive(stranger.pid!), true, 'the process that reused the pid is untouched');
    } finally {
      try {
        process.kill(-stranger.pid!, 'SIGKILL');
      } catch {}
    }
  });
});
