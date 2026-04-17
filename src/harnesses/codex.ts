import type { HarnessConfig } from '../types.ts';
import { emulateForkCodex } from '../fork-emulation.ts';

/**
 * Codex CLI harness config.
 *
 * Session management:
 *   Create: implicit (Codex assigns thread_id on first turn)
 *   Resume: `codex exec resume <thread_id>` (subcommand, not flag)
 *
 * Model decomposition:
 *   Composite IDs like 'gpt-5.3-codex-high' are split into:
 *     -m gpt-5.3-codex -c model_reasoning_effort=high
 *   Standalone models (in STANDALONE_MODELS) pass through directly.
 *
 * Working directory:
 *   -C <path> on first turn only. Omitted on resume (session has its own cwd).
 */

/** Effort levels codex accepts for `-c model_reasoning_effort=`.
 *  Source: `codex exec -c model_reasoning_effort=<invalid>` rejects with
 *  "expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`".
 *  'none' is handled by absence (no `-c` flag emitted), so it's not here. */
const EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

/** Models that pass directly without effort decomposition. */
const STANDALONE_MODELS = new Set(['gpt-5.3-codex-spark']);

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

  decomposeModel: (modelId) => {
    // Standalone models — pass directly, no effort decomposition
    if (STANDALONE_MODELS.has(modelId)) {
      return ['-m', modelId];
    }

    // Decompose composite ID: "gpt-5.3-codex-high" → model + effort
    for (const effort of EFFORT_LEVELS) {
      if (modelId.endsWith(`-${effort}`)) {
        const model = modelId.slice(0, -(effort.length + 1));
        return ['-m', model, '-c', `model_reasoning_effort=${effort}`];
      }
    }

    // No known effort suffix — pass as-is
    return ['-m', modelId];
  },

  // Standalone reasoning parameter (oompa passes reasoning separately).
  // Skipped if decomposeModel already extracted effort from composite ID.
  reasoningFlags: (level) => ['-c', `model_reasoning_effort=${level}`],
};
