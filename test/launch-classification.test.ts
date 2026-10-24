import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { attachExecution, executeCommand } from '../src/execute.ts';
import type { ExecutionHandle, UnifiedAgentEvent } from '../src/runtime-types.ts';

async function collect(turn: ExecutionHandle) {
  const events: UnifiedAgentEvent[] = [];
  for await (const event of turn.events) events.push(event);
  return { completion: await turn.completed, errors: events.flatMap((e) => e.type === 'error' ? [e.message] : []) };
}

// Real shell/journal boundaries: provider stderr is not launch authority, and a previous
// successful lookup must not freeze PATH/cwd or a removed executable for later turns.
test('launch discovery distinguishes a missing agent from its own exit 127, including adoption', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-cli-launch-'));
  const saved = process.env.PATH;
  const bins = ['first', 'second'].map((name) => path.join(root, name));
  const writeShim = (dir: string, source: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'codex'), `#!/bin/sh\n${source}\n`);
    chmodSync(path.join(dir, 'codex'), 0o755);
  };
  const success = `printf '%s\\n' '{"type":"turn.completed"}'`;
  const request = { harness: 'codex' as const, mode: 'conversation' as const, prompt: 'hi', cwd: root };
  try {
    writeShim(bins[0], success);
    process.env.PATH = `${bins[0]}:/usr/bin:/bin`;
    assert.equal((await collect(executeCommand(request))).completion.reason, 'success');

    // No provider stdout is required for the ambiguity: even startup diagnostics can
    // name codex and a missing nested tool. Also cover a CLI that already emitted text.
    for (const started of [false, true]) {
      writeShim(bins[0], `${started ? `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"working"}}'` : ''}
echo 'codex: nested-tool: not found' >&2
exit 127`);
      const dir = path.join(root, `failure-${started}`);
      const result = await collect(executeCommand({ ...request, journalDir: dir }));
      assert.equal(result.completion.exitCode, 127);
      assert.equal(result.completion.reason, 'error');
      assert.ok(result.errors.some((m) => /exit=127.*nested-tool: not found/.test(m)), result.errors.join('\n'));
      assert.ok(result.errors.every((m) => !/spawn codex ENOENT/.test(m)));
      assert.deepEqual(await collect(attachExecution(dir)), result, 'adoption uses the same failure authority');
      writeFileSync(path.join(dir, 'exit.json'), '{"status":127}\n');
      assert.deepEqual(await collect(attachExecution(dir)), result, 'legacy journals do not guess from stderr');
    }

    // PATH switched while the old executable still exists: a cached path runs the wrong CLI.
    writeShim(bins[1], success);
    process.env.PATH = `${bins[1]}:/usr/bin:/bin`;
    assert.equal((await collect(executeCommand(request))).completion.reason, 'success');
    // Same PATH, executable removed after a successful turn: report a true discovery failure.
    rmSync(path.join(bins[1], 'codex'));
    process.env.PATH = bins[1]; // The journal must record missing commands even without coreutils on PATH.
    const missingDir = path.join(root, 'missing');
    const missing = await collect(executeCommand({ ...request, journalDir: missingDir }));
    assert.ok(missing.errors.includes('spawn codex ENOENT'), missing.errors.join('\n'));
    assert.deepEqual(await collect(attachExecution(missingDir)), missing);

    // Relative PATH is interpreted at the requested cwd, not the backend's cwd.
    writeShim(bins[1], success);
    process.env.PATH = 'second:/usr/bin:/bin';
    assert.equal((await collect(executeCommand(request))).completion.reason, 'success');

    // An executable with an absent shebang interpreter is found but cannot run.
    writeShim(bins[1], success);
    writeFileSync(path.join(bins[1], 'codex'), '#!/definitely-missing-agent-cli-interpreter\n');
    const broken = await collect(executeCommand(request));
    assert.equal(broken.completion.reason, 'error');
    assert.ok(broken.errors.every((m) => !/spawn codex ENOENT/.test(m)), broken.errors.join('\n'));

    // The existing Cursor alias fallback still works with a PATH containing only the legacy name.
    writeFileSync(path.join(bins[1], 'cursor-agent'), `#!/bin/sh\necho ready\n`);
    chmodSync(path.join(bins[1], 'cursor-agent'), 0o755);
    process.env.PATH = bins[1];
    const cursor = await collect(executeCommand({ ...request, harness: 'cursor', mode: 'single-shot' }));
    assert.equal(cursor.completion.reason, 'success');
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
