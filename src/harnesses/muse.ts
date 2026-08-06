import type { HarnessConfig } from '../types.ts';

/**
 * Muse CLI harness config (Muse Code).
 *
 * Session management:
 *   Create: --session-id <uuid>  (muse exec --session-id <uuid> "prompt")
 *   Resume: --session-id <uuid>  (same flag; sequence continues with same session.id)
 *   Storage: ~/.local/share/muse/sessions/YYYY/MM/DD + ~/.config/muse/settings.json
 *
 * Model / reasoning:
 *   --model <id>  (e.g. muse-spark-1.2-contributor, per ~/.config/muse/settings.json)
 *   --reasoning-effort <none|minimal|low|medium|high|xhigh|ultra>  (default high)
 *
 * Prompt:
 *   Positional last arg: muse exec --json --session-id <id> "prompt"
 *
 * Bypass:
 *   --yolo  (disables approval + sandbox, trusted workspace)
 *
 * Workspace:
 *   --workspace <PATH> on first turn only (resume inherits workspace)
 */
export const museConfig: HarnessConfig = {
  binary: 'muse',
  baseCmd: ['exec'],
  bypassFlags: ['--yolo'],
  modelFlag: '--model',
  promptVia: 'cli-arg',
  stdin: 'close',
  stdout: 'jsonl',
  cwdFlag: '--workspace',

  // Both create and resume use the same flag; build.ts suppresses create on resume
  sessionCreateFlags: (id) => ['--session-id', id],
  sessionResumeFlags: (id) => ['--session-id', id],

  reasoningFlags: (level) => ['--reasoning-effort', level],
};
