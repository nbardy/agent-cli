import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

const tempDirectory = mkdtempSync(path.join(tmpdir(), 'agent-cli-codex-stdin-'));
const execFileAsync = promisify(execFile);

after(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

test('Codex sends prompts larger than ARG_MAX through stdin', async () => {
  const shimPath = path.join(tempDirectory, 'codex');
  writeFileSync(shimPath, '#!/bin/sh\nwc -c\n');
  chmodSync(shimPath, 0o755);

  const runnerUrl = new URL('../src/process-runner.ts', import.meta.url).href;
  const script = `
    import { runCommand } from ${JSON.stringify(runnerUrl)};
    const prompt = 'x'.repeat(2 * 1024 * 1024);
    let childStdout = '';
    const turn = runCommand('codex', {
      prompt,
      onStdout: (chunk) => { childStdout += chunk.toString('utf8'); },
    });
    const result = await turn.done;
    console.log(JSON.stringify({
      exitCode: result.exitCode,
      receivedBytes: Number.parseInt(childStdout.trim(), 10),
      expectedBytes: Buffer.byteLength(prompt),
      argvEndsWithStdinMarker: turn.spec.argv.at(-1) === '-',
      promptInArgv: turn.spec.argv.includes(prompt),
      stdin: turn.spec.stdin,
    }));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    {
      env: {
        ...process.env,
        PATH: `${tempDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
      },
      maxBuffer: 1024 * 1024,
    }
  );
  const result = JSON.parse(stdout.trim()) as {
    exitCode: number;
    receivedBytes: number;
    expectedBytes: number;
    argvEndsWithStdinMarker: boolean;
    promptInArgv: boolean;
    stdin: string;
  };

  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.receivedBytes, result.expectedBytes);
  assert.strictEqual(result.argvEndsWithStdinMarker, true);
  assert.strictEqual(result.promptInArgv, false);
  assert.strictEqual(result.stdin, 'prompt');
});
