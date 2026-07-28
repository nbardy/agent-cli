import { emulateForkCodex } from '../fork-emulation.ts';
import type { HarnessConfig } from '../types.ts';

/**
 * Codex CLI harness config.
 *
 * Session management:
 *   Create: implicit (Codex assigns thread_id on first turn)
 *   Resume: `codex exec resume <thread_id>` (subcommand, not flag)
 *
 * Model and reasoning values are independent opaque inputs. The application
 * owns any legacy composite migration; this harness never guesses from suffixes.
 *
 * Working directory:
 *   -C <path> on first turn only. Omitted on resume (session has its own cwd).
 */

export const codexConfig: HarnessConfig = {
  binary: 'codex',
  baseCmd: ['exec'],
  // --skip-git-repo-check: skip git repo validation (needed for worktrees
  // where .git is a file, not a directory). Safe to include always.
  extraArgs: ['--skip-git-repo-check'],
  // --dangerously-bypass-approvals-and-sandbox: skip all confirmations.
  bypassFlags: ['--dangerously-bypass-approvals-and-sandbox'],
  modelFlag: '-m',
  promptVia: 'cli-sep',
  promptSep: '--',
  stdin: 'close',
  stdout: 'jsonl',
  cwdFlag: '-C',

  // Resume changes the subcommand: 'exec resume <id>' instead of 'exec ...'
  // These args are inserted right after baseCmd in the build function.
  sessionResumeFlags: (id) => ['resume', id],

  // Codex has no native non-interactive fork flag (`codex fork` is
  // interactive, `codex exec resume` has no --fork). We fork by copying
  // the rollout file under ~/.codex/sessions/YYYY/MM/DD/ to a fresh uuid
  // (rewriting the first session_meta.payload.id), then --resume the copy.
  // Source file is untouched. See fork-emulation.ts.
  emulateFork: (sourceSessionId) => emulateForkCodex(sourceSessionId),

  // Standalone reasoning parameter. Passed through verbatim.
  reasoningFlags: (level) => ['-c', `model_reasoning_effort=${level}`],
};
