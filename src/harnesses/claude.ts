import type { HarnessConfig } from '../types.ts';

/**
 * Claude CLI harness config.
 *
 * Session management:
 *   Create: --session-id <uuid>
 *   Resume: --resume <uuid>
 *
 * IMPORTANT: --resume takes the session ID as its VALUE.
 * Combining --session-id <id> --resume is REJECTED by Claude CLI
 * (unless --fork-session is also passed). This was a real bug in
 * oompa_loompas that wasted half of all swarm iterations — and is
 * the reason this shared tool exists.
 */
export const claudeConfig: HarnessConfig = {
  binary: 'claude',
  baseCmd: [],
  bypassFlags: ['--dangerously-skip-permissions'],
  modelFlag: '--model',
  promptVia: 'flag',
  promptFlag: '-p',
  stdin: 'prompt',
  stdout: 'jsonl',
  sessionCreateFlags: (id) => ['--session-id', id],
  sessionResumeFlags: (id) => ['--resume', id],
  // Fork: --resume <id> --fork-session assigns a new session id while
  // inheriting the original transcript (tool_use + tool_result blocks intact).
  // The original session is left untouched.
  sessionForkFlags: (id) => ['--resume', id, '--fork-session'],
};
