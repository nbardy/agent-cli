import { spawn, type ChildProcess } from 'node:child_process';
import { buildCommand } from './build.ts';
import type { CommandSpec } from './types.ts';
import type { RunOptions, RunResult } from './runtime-types.ts';

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
  if (options.onStdout && child.stdout) child.stdout.on('data', options.onStdout);
  if (options.onStderr && child.stderr) child.stderr.on('data', options.onStderr);

  const done = new Promise<RunResult>((resolve, reject) => {
    child.on('close', (code) => resolve({ exitCode: code, spec }));
    child.on('error', reject);
  });

  return { child, spec, done };
}
