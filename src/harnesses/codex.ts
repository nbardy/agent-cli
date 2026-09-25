import { emulateForkCodex } from '../fork-emulation.ts';
import { type McpKindEncoders, encodeMcpServers, headersViaEnv } from '../mcp-encoding.ts';
import type { HarnessConfig, McpEncoding, McpServerSpec } from '../types.ts';

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

/** TOML inline table of string values; keys quoted with the same JSON rule. */
function tomlInlineTable(entries: Readonly<Record<string, string>>): string {
  return `{${Object.entries(entries)
    .map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`)
    .join(',')}}`;
}

const codexMcpEncoders: McpKindEncoders<readonly string[]> = {
  stdio: (name, spec) => {
    const env = spec.env ?? {};
    const args = [
      '-c',
      `mcp_servers.${name}.command=${tomlString(spec.command)}`,
      '-c',
      `mcp_servers.${name}.args=${tomlStringArray(spec.args)}`,
      '-c',
      `mcp_servers.${name}.enabled=true`,
      ...(spec.required ? ['-c', `mcp_servers.${name}.required=true`] : []),
      ...(spec.cwd ? ['-c', `mcp_servers.${name}.cwd=${tomlString(spec.cwd)}`] : []),
      ...(Object.keys(env).length > 0
        ? ['-c', `mcp_servers.${name}.env_vars=${tomlStringArray(Object.keys(env))}`]
        : []),
    ];
    return { entry: args, env };
  },
  // A `url` makes the server `streamable_http`. Codex rejects an inline
  // `bearer_token`; `env_http_headers` maps header → env var name and covers
  // Authorization as well as any other header, so every value rides the
  // process env. Verified 2026-09-25 against codex-cli 0.156.1: `codex mcp
  // get -c …` reports transport streamable_http with these env_http_headers,
  // an exec against a local server delivered `Authorization: Bearer <value>`,
  // and a 401 with required=true aborted the session before any model call.
  http: (name, spec) => {
    const headers = headersViaEnv(name, spec.headers ?? {}, (envName) => envName);
    const args = [
      '-c',
      `mcp_servers.${name}.url=${tomlString(spec.url)}`,
      '-c',
      `mcp_servers.${name}.enabled=true`,
      ...(spec.required ? ['-c', `mcp_servers.${name}.required=true`] : []),
      ...(Object.keys(headers.headers).length > 0
        ? ['-c', `mcp_servers.${name}.env_http_headers=${tomlInlineTable(headers.headers)}`]
        : []),
    ];
    return { entry: args, env: headers.env };
  },
};

function codexMcpEncoding(servers: Readonly<Record<string, McpServerSpec>>): McpEncoding {
  const { entries, env } = encodeMcpServers(codexMcpEncoders, servers);
  return { args: entries.flatMap(([, args]) => args), env, ownedPaths: [] };
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
  promptVia: 'stdin',
  stdin: 'prompt',
  stdinPromptArg: '-',
  stdout: 'jsonl',
  mcpCapability: 'required',
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
  mcp: (servers) => codexMcpEncoding(servers),
};
