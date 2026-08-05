import type { HarnessConfig } from '../types.ts';

/**
 * Cursor Agent CLI harness.
 *
 * Prefer the dedicated `cursor-agent` binary over `cursor agent …` (Electron
 * app wrapper). Flags are the same; argv starts at the agent options.
 *
 * Resume uses `--resume <chatId>`. No sessionForkFlags / emulateFork: Cursor
 * is absent from FORK_CAPABLE_PROVIDERS (merge provider-session forks only).
 * Chat "Fork" soft handoff still works for Cursor — that path never needs
 * CLI session inheritance.
 */
export const cursorConfig: HarnessConfig = {
  binary: 'cursor-agent',
  baseCmd: ['--print', '--output-format', 'stream-json', '--stream-partial-output'],
  bypassFlags: ['-f'],
  modelFlag: '--model',
  promptVia: 'cli-arg',
  stdin: 'close',
  stdout: 'jsonl',

  sessionResumeFlags: (id) => ['--resume', id],
};
