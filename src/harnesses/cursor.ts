import type { HarnessConfig } from '../types.ts';

export const cursorConfig: HarnessConfig = {
  binary: 'cursor',
  baseCmd: ['agent', '--print', '--output-format', 'stream-json', '--stream-partial-output'],
  bypassFlags: [],
  modelFlag: '--model',
  promptVia: 'cli-arg',
  stdin: 'close',
  stdout: 'jsonl',

  sessionResumeFlags: (id) => ['--resume', id],
};
