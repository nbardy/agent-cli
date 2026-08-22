import { type ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { buildCommand } from './build.ts';
import { resolveBinary } from './resolve.ts';
import type { RunOptions, RunResult } from './runtime-types.ts';
import type { CommandSpec } from './types.ts';

export function attachReadableStream(
  stream: Readable,
  onData: (data: Buffer) => void,
  onState?: RunOptions['onStdoutState']
): void {
  const report = (event: 'attached' | 'resume' | 'pause' | 'close') => {
    onState?.({
      event,
      readableFlowing: stream.readableFlowing,
      readableLength: stream.readableLength,
    });
  };
  stream.on('data', onData);
  stream.on('resume', () => report('resume'));
  stream.on('pause', () => report('pause'));
  stream.on('close', () => report('close'));
  report('attached');
  // A data listener normally enters flowing mode automatically. Make that
  // contract explicit: Node 24/macOS has been observed leaving a detached
  // Codex stdout socket paused with its first JSONL event unread.
  stream.resume();
}

export function runCommand(
  harness: string,
  options: RunOptions = {}
): { child: ChildProcess; spec: CommandSpec; done: Promise<RunResult> } {
  const spec = buildCommand(harness, options);
  const [bin, ...args] = spec.argv;
  // Cursor binary fallback: harness now builds `agent` but older installs
  // only have `cursor-agent`. Resolve through resolveBinary which probes
  // `agent` → `cursor-agent` fallback; on spawn we use the resolved path
  // so ENOENT never surfaces, but spec.argv stays canonical (`agent`).
  let effectiveBin = bin;
  try {
    effectiveBin = resolveBinary(bin);
  } catch {
    // let spawn handle ENOENT with its own error path
  }
  const useCallbacks = !!options.onStdout || !!options.onStderr;
  const child = spawn(effectiveBin, args, {
    cwd: options.cwd,
    detached: options.detached === true,
    // Harness-provided env is an overlay. Replacing process.env here would
    // drop PATH, credentials, and provider configuration from the child.
    ...(spec.env ? { env: { ...process.env, ...spec.env } } : {}),
    stdio: ['pipe', useCallbacks ? 'pipe' : 'inherit', useCallbacks ? 'pipe' : 'inherit'],
  });

  if (child.stdin) {
    if (spec.stdin === 'prompt' && spec.prompt) child.stdin.write(spec.prompt);
    if (spec.stdin !== 'pipe') child.stdin.end();
  }
  if (options.onStdout && child.stdout) {
    attachReadableStream(child.stdout, options.onStdout, options.onStdoutState);
  }
  if (options.onStderr && child.stderr) child.stderr.on('data', options.onStderr);

  const done = new Promise<RunResult>((resolve, reject) => {
    child.on('close', (code, signal) => resolve({ exitCode: code, signal, spec }));
    child.on('error', reject);
  });

  return { child, spec, done };
}
