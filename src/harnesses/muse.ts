import { buildMuseMcpConfigDir } from '../muse-mcp-settings.ts';
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
 *
 * MCP encoding is file-based: muse takes no MCP argv or env, so the encoder
 * merges canonical server specs into the `mcpServers` block of a copy of
 * the user's settings.json and redirects the child via XDG_CONFIG_HOME (see
 * muse-mcp-settings.ts). Entries carry explicit `mode` (required/optional)
 * and the CLI aborts the run when a required server fails startup, which is
 * the behavioral fail-closed contract Buddy turns require — verified
 * empirically: a nonexistent required command ends the run with
 * `run.terminal.failed` before any model step.
 */
export const museConfig: HarnessConfig = {
  mcpCapability: 'required',
  binary: 'muse',
  baseCmd: ['exec'],
  bypassFlags: ['--yolo'],
  modelFlag: '--model',
  promptVia: 'cli-arg',
  stdin: 'close',
  stdout: 'jsonl',
  cwdFlag: '--workspace',

  // File-based MCP: materialize the merged settings dir and redirect the
  // child at it. Additive — the user's own servers survive the merge, and a
  // name conflict with different content throws instead of shadowing.
  mcp: (servers) => {
    const { baseDir } = buildMuseMcpConfigDir(servers);
    return { args: [], env: { XDG_CONFIG_HOME: baseDir }, ownedPaths: [baseDir] };
  },

  // Both create and resume use the same flag; build.ts suppresses create on resume
  sessionCreateFlags: (id) => ['--session-id', id],
  sessionResumeFlags: (id) => ['--session-id', id],

  reasoningFlags: (level) => ['--reasoning-effort', level],
};
