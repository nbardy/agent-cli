import { emulateForkCodex } from '../fork-emulation.ts';
import type { HarnessConfig, McpServerSpec } from '../types.ts';

/**
 * Codex reads MCP config as TOML `-c key=value` fragments. TOML string values
 * are double-quoted with backslash escapes — exactly JSON string syntax — so
 * JSON.stringify is the correct quoter here, not a coincidence.
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`;
}

function codexMcpArgs(servers: Readonly<Record<string, McpServerSpec>>): string[] {
  const args: string[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    args.push('-c', `mcp_servers.${name}.command=${tomlString(spec.command)}`);
    args.push('-c', `mcp_servers.${name}.args=${tomlStringArray(spec.args)}`);
    args.push('-c', `mcp_servers.${name}.enabled=true`);
    if (spec.required) args.push('-c', `mcp_servers.${name}.required=true`);
    if (spec.cwd) args.push('-c', `mcp_servers.${name}.cwd=${tomlString(spec.cwd)}`);
  }
  return args;
}

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

  // MCP: one `-c` group per server. Additive — `-c` overlays the user's
  // ~/.codex/config.toml rather than replacing it, so globally-configured
  // servers stay available alongside the injected ones.
  // This is the only MCP path currently running in production (moved here
  // verbatim from unleashd's buddyCodexMcpArgs); byte-for-byte output shape
  // is pinned by test/mcp.test.ts.
  mcp: (servers) => ({ args: codexMcpArgs(servers) }),
};
