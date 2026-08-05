import { type ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { buildCommand } from './build.ts';
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
  const useCallbacks = !!options.onStdout || !!options.onStderr;
  const child = spawn(bin, args, {
    cwd: options.cwd,
    detached: options.detached === true,
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
