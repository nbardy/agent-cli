import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { executionProcess, followJournal, spawnJournaled, verifyExecutions } from '../src/journal.ts';

// Regression guard (2026-10-23): isOwnWrapper ran execFileSync('ps') from followJournal's tick and
// oompa's poll; a live sample put 74% of the server main thread in SyncProcessRunner::Spawn.
// Following a live journal, polling its liveness and re-verifying identity must never spawn
// synchronously (it would stall every WebSocket and turn on the same event loop).
describe('journal liveness is never a synchronous spawn', () => {
  it('follows a >1s live execution with sync spawns forbidden', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'journal-nosync-'));
    const real = { execFileSync: childProcess.execFileSync, execSync: childProcess.execSync, spawnSync: childProcess.spawnSync };
    try {
      writeFileSync(path.join(dir, 'execution.json'), '{}');
      const pid = spawnJournaled(dir, '/bin/sh', ['-c', 'echo hello; sleep 1.5; echo bye'], { stdin: '' });
      const forbid = () => {
        throw new Error('synchronous spawn on the journal path');
      };
      Object.assign(childProcess, { execFileSync: forbid, execSync: forbid, spawnSync: forbid });
      syncBuiltinESMExports();
      let out = '';
      const polls: string[] = [];
      const timer = setInterval(() => {
        polls.push(executionProcess(dir).t);
      }, 100);
      const end = await followJournal(dir, {
        onStdout: (c) => (out += c),
        onStderr: () => undefined,
      });
      clearInterval(timer);
      await verifyExecutions([dir]);
      assert.equal(end.kind, 'exited');
      assert.equal(out, 'hello\nbye\n');
      assert.ok(polls.includes('live'), `never saw live: ${polls}`);
      assert.ok(pid > 0);
    } finally {
      Object.assign(childProcess, real);
      syncBuiltinESMExports();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The safety the cache must keep: a pid that is alive but is not our wrapper is `ended`.
  it('a live pid whose command never names the dir is not our wrapper', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'journal-reuse-'));
    try {
      writeFileSync(path.join(dir, 'pid'), String(process.pid));
      assert.equal(executionProcess(dir).t, 'ended');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression guard (2026-10-23, oompa-poll #1 stall): a live pid that is not our wrapper was
  // never cached, so every check re-ran the sync `ps`. After the first probe it must cost none.
  it('a reused pid is probed once, not every check', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'journal-stranger-'));
    const real = childProcess.execFileSync;
    let spawns = 0;
    try {
      writeFileSync(path.join(dir, 'pid'), String(process.pid));
      Object.assign(childProcess, {
        execFileSync: (...args: Parameters<typeof real>) => {
          spawns++;
          return real(...args);
        },
      });
      syncBuiltinESMExports();
      for (let i = 0; i < 20; i++) assert.equal(executionProcess(dir).t, 'ended');
      assert.equal(spawns, 1);
    } finally {
      Object.assign(childProcess, { execFileSync: real });
      syncBuiltinESMExports();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
