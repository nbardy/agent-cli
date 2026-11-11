import { ENFORCED, advisory } from '../capabilities.ts';
import { emulateForkCodex } from '../fork-emulation.ts';
import { type McpKindEncoders, encodeMcpServers, headersViaEnv } from '../mcp-encoding.ts';
import type {
  CapabilityEncoding,
  Enforcement,
  HarnessConfig,
  McpEncoding,
  McpServerSpec,
  TurnCapabilities,
  TurnFiles,
} from '../types.ts';

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

// ---- Capability sets (types.ts `TurnCapabilities`) ----
//
// Verified 2026-11-11 against codex-cli 0.159.0 and 0.160.0: every flag below is in
// `codex exec --help`, every feature name in `codex features list` (`--disable` rejects an
// unknown name, so a renamed feature fails the turn at start instead of being skipped), and every
// `-c` key and value parses (`codex debug prompt-input -c …` rejects a bad key's type or variant
// and renders the model-visible input without calling a model).
// - `--ignore-user-config` drops `~/.codex/config.toml`: its MCP servers (the owner's held
//   computer-use, node_repl and others), plugins, `sandbox_mode = "danger-full-access"`, notify
//   hook and hook trust. Login still comes from CODEX_HOME. It also drops the configured default
//   model and effort, so a capability turn runs on the model and effort its request names.
// - `--ignore-rules` drops user and project execpolicy rules, which could allow a command out of
//   the sandbox. `approval_policy = "never"`: a sandbox denial goes back to the model as a
//   failed command, never to an approval nobody would give.
// - The sandbox confines writes (read-only, or workspace-write = the cwd only: TMPDIR and /tmp
//   excluded) and the shell's network. It does not confine reads: Codex reads files through its
//   shell, so the shell stays on even when the set says `off` (advisory, below).
// - `project_doc_max_bytes = 0` drops the repository's AGENTS.md (prompt-input: gone).
//   Nothing drops `$CODEX_HOME/AGENTS.md`, the owner's global file: only moving CODEX_HOME would,
//   and that moves the login and the session files the server ingests. The first real run's
//   prompt began with it (3,057 characters).
// - multi_agent and multi_agent_v2 are disabled, but prompt-input still shows Codex's
//   multi-agent role text with both off, so the tools' absence is not observable here.
const CODEX_ALWAYS_OFF = [
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'plugins',
  'hooks',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'computer_use',
  'in_app_local_automation',
] as const;
const CODEX_WEB = {
  off: 'disabled',
  on: 'live',
} as const satisfies Record<TurnCapabilities['web'], string>;
const CODEX_GLOBAL_INSTRUCTIONS =
  "codex always loads the owner's $CODEX_HOME/AGENTS.md; only a different CODEX_HOME skips it, which would also move its login and sessions";
const CODEX_INSTRUCTIONS: {
  readonly [K in TurnCapabilities['instructions']]: {
    readonly args: readonly string[];
    readonly report: Enforcement;
  };
} = {
  none: {
    args: ['-c', 'project_doc_max_bytes=0'],
    report: advisory(`the repository's AGENTS.md is off, but ${CODEX_GLOBAL_INSTRUCTIONS}`),
  },
  project: { args: [], report: advisory(CODEX_GLOBAL_INSTRUCTIONS) },
};
const CODEX_READS = advisory(
  "codex's sandbox confines writes and network, not reads: its shell can read the whole disk"
);
const CODEX_SHELL_STAYS = advisory(
  'codex reads files only through its shell, so the shell stays on, inside the sandbox (no writes outside its directory, no network)'
);
const CODEX_FILES: {
  readonly [K in TurnFiles['t']]: (f: Extract<TurnFiles, { t: K }>) => {
    readonly args: readonly string[];
    readonly shell: Enforcement;
  };
} = {
  read: () => ({ args: ['-s', 'read-only'], shell: CODEX_SHELL_STAYS }),
  write: (f) => ({
    args: [
      '-s',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c',
      'sandbox_workspace_write.exclude_tmpdir_env_var=true',
      '-c',
      'sandbox_workspace_write.exclude_slash_tmp=true',
    ],
    shell: CODEX_SHELL[f.shell],
  }),
};
const CODEX_SHELL: { readonly [S in Extract<TurnFiles, { t: 'write' }>['shell']]: Enforcement } =
  {
    off: CODEX_SHELL_STAYS,
    on: ENFORCED,
  };

function codexCapabilities(caps: TurnCapabilities): CapabilityEncoding {
  const files = (
    CODEX_FILES[caps.files.t] as (f: TurnFiles) => ReturnType<(typeof CODEX_FILES)['read']>
  )(caps.files);
  const instructions = CODEX_INSTRUCTIONS[caps.instructions];
  return {
    t: 'enforcing',
    args: [
      '--ignore-user-config',
      '--ignore-rules',
      '-c',
      'approval_policy="never"',
      ...files.args,
      '-c',
      `web_search="${CODEX_WEB[caps.web]}"`,
      ...instructions.args,
      ...CODEX_ALWAYS_OFF.flatMap((feature) => ['--disable', feature]),
    ],
    report: {
      reads: CODEX_READS,
      writes: ENFORCED,
      shell: files.shell,
      web: ENFORCED,
      agents: advisory(
        "multi_agent and multi_agent_v2 are disabled, but codex still describes spawn_agent in its prompt, so the tools' absence is not verified"
      ),
      schedule: ENFORCED,
      mcp: ENFORCED,
      instructions: instructions.report,
    },
  };
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
  capabilities: codexCapabilities,
};
