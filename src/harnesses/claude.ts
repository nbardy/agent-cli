import { ENFORCED, advisory } from '../capabilities.ts';
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
 * How long `claude -p` waits for background agents after the main thread goes
 * idle. Claude Code's own default is 600000 (10 minutes); after that it
 * prints "Background tasks still running after Ns; terminating.", stops the
 * agents, and exits 0. Twelve hours matches a long Buddy turn. Callers override
 * by setting CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS themselves.
 */
export const CLAUDE_PRINT_BG_WAIT_CEILING_MS = 12 * 60 * 60 * 1000;
export const CLAUDE_PRINT_BG_WAIT_CEILING_ENV = 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS';

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
/**
 * Claude takes MCP config as a single `--mcp-config` value that is either a
 * file path or an inline JSON document. Inline avoids a temp file we would
 * then have to reap.
 *
 * Buddy turns use `--strict-mcp-config` so the process has a deterministic MCP
 * surface. This intentionally does not merge the user's global MCP servers:
 * authority-bearing Buddy tools must not be shadowed by or mixed with an
 * unrelated workspace configuration. Ordinary Claude conversations do not
 * pass MCP config and keep the normal global configuration behavior.
 *
 * Claude has no per-server "required" knob: a server that fails to connect
 * is reported as `status:"failed"` in the init event and the turn runs on
 * without it. Required HTTP servers are therefore probed by the runner
 * (mcp-startup.ts); required stdio servers rely on the explicit, isolated
 * process configuration and the caller's Buddy tool contract.
 */
const claudeMcpEncoders: McpKindEncoders<Record<string, unknown>> = {
  // Stdio env goes on the claude process, which its MCP children inherit;
  // values stay out of argv.
  stdio: (_name, spec) => ({
    entry: {
      command: spec.command,
      args: [...spec.args],
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    },
    env: spec.env ?? {},
  }),
  // Claude expands `${VAR}` inside an inline `--mcp-config` document
  // (verified 2026-09-25 against claude 2.1.282: a local streamable-HTTP
  // server received `Authorization: Bearer <value of VAR>`), so the header
  // value rides the process env and argv only carries the reference.
  http: (name, spec) => {
    const headers = headersViaEnv(name, spec.headers ?? {}, (envName) => `\${${envName}}`);
    return { entry: { type: 'http', url: spec.url, headers: headers.headers }, env: headers.env };
  },
};

function claudeMcpEncoding(servers: Readonly<Record<string, McpServerSpec>>): McpEncoding {
  const { entries, env } = encodeMcpServers(claudeMcpEncoders, servers);
  const mcpServers = Object.fromEntries(entries);
  return {
    args: ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers })],
    env,
    ownedPaths: [],
  };
}

// ---- Capability sets (types.ts `TurnCapabilities`) ----
//
// Verified against claude 2.1.322 (`claude --help` and the shipped bundle), 2026-11-11:
// - `--tools` is the whole built-in set the model sees. A tool left out cannot be called, so
//   sub-agents (Task/Agent, Workflow), Cron*, RemoteTrigger, ScheduleWakeup, Skill and the rest
//   are gone, not merely denied.
// - `--permission-mode dontAsk` denies anything not pre-approved instead of prompting, and
//   `--permission-prompts none` denies anything that would still prompt: a refused call returns
//   an error tool result and the turn goes on. Nothing ever waits for an approval.
// - `permissions.blockReadsOutsideWorkingDirectories` / `blockWritesOutsideWorkingDirectories`
//   refuse file-tool reads and writes outside the cwd and `--add-dir` directories in every
//   permission mode ("No allow rule lifts it"). Writes inside a read root are refused because
//   only `Edit(//<dir>/**)` is pre-approved and dontAsk denies the rest.
// - CLAUDE.md loading follows the setting sources: the user's `~/.claude/CLAUDE.md` loads only
//   when `userSettings` is a source, the repository's only with `projectSettings`, CLAUDE.local.md
//   only with `localSettings`. `--setting-sources ""` loads none of them (nor the user's hooks,
//   plugins and permission rules); `--settings` (flag settings) still applies. The first real run
//   loaded the 2,251-character global CLAUDE.md into every call (2026-11-11 smoke transcripts).
//   `--restricted` is NOT used: it forces the sources to none, which would also drop a checkout
//   call's project CLAUDE.md.
// - `autoMemoryEnabled: false` keeps the harness's own auto-memory out (harness-memory note in
//   the server). It must ride in the same `--settings` document: two `--settings` flags do not
//   merge, which is why a capability turn takes no caller `extraArgs` (execute.ts).
// - Bash, when granted, runs in Claude's sandbox: writes inside the working directories only,
//   `denyWrite` for the read roots, no network (no allowed domains), no unsandboxed escape, and
//   the turn fails at start if the sandbox cannot run. The sandbox does not confine reads.
const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;
const CLAUDE_WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;
const CLAUDE_WEB = {
  off: [],
  on: ['WebSearch', 'WebFetch'],
} as const satisfies Record<TurnCapabilities['web'], readonly string[]>;
const CLAUDE_SOURCES = {
  none: '',
  project: 'project',
} as const satisfies Record<TurnCapabilities['instructions'], string>;

/** A pre-approval for Claude's file-editing tools under an absolute directory (`//` = root). */
const editRule = (dir: string) => `Edit(/${dir}/**)`;

type ClaudeFiles = {
  readonly tools: readonly string[];
  readonly addDirs: readonly string[];
  readonly allow: readonly string[];
  readonly sandbox: Readonly<Record<string, unknown>>;
  readonly reads: Enforcement;
};
const CLAUDE_SHELL: {
  readonly [S in Extract<TurnFiles, { t: 'write' }>['shell']]: (reads: readonly string[]) => {
    readonly tools: readonly string[];
    readonly allow: readonly string[];
    readonly sandbox: Readonly<Record<string, unknown>>;
    readonly reads: Enforcement;
  };
} = {
  off: () => ({ tools: [], allow: [], sandbox: {}, reads: ENFORCED }),
  on: (reads) => ({
    tools: ['Bash'],
    allow: ['Bash'],
    sandbox: {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: [...reads] },
      },
    },
    reads: advisory(
      "Bash runs in Claude's sandbox, which confines its writes and network but not what it reads"
    ),
  }),
};
const CLAUDE_FILES: {
  readonly [K in TurnFiles['t']]: (f: Extract<TurnFiles, { t: K }>) => ClaudeFiles;
} = {
  read: (f) => ({
    tools: CLAUDE_READ_TOOLS,
    addDirs: f.roots,
    allow: [],
    sandbox: {},
    reads: ENFORCED,
  }),
  // `f.git` adds nothing here: Claude's sandbox resolves a linked worktree's git directory itself
  // (its bundle handles a worktree's `commondir`), and in the second real run (2026-11-11) a
  // checkout call committed from its sandboxed Bash with exactly this argv. What else of the
  // main repository's `.git` that leaves writable to Bash was not probed.
  write: (f) => {
    const shell = CLAUDE_SHELL[f.shell](f.reads);
    return {
      tools: [...CLAUDE_READ_TOOLS, ...CLAUDE_WRITE_TOOLS, ...shell.tools],
      addDirs: f.reads,
      allow: [editRule(f.dir), ...shell.allow],
      sandbox: shell.sandbox,
      reads: shell.reads,
    };
  },
};

function claudeCapabilities(caps: TurnCapabilities): CapabilityEncoding {
  const files = (CLAUDE_FILES[caps.files.t] as (f: TurnFiles) => ClaudeFiles)(caps.files);
  const web = CLAUDE_WEB[caps.web];
  const settings = {
    autoMemoryEnabled: false,
    permissions: {
      // Run 3: the read block disables sandbox auto-allow and inspects shell syntax before
      // the broad Bash grant. Shell reads were already advisory; the sandbox is its boundary.
      // Guard: capabilities.test.ts checkout settings (all other turn kinds keep the read block).
      blockReadsOutsideWorkingDirectories: !(caps.files.t === 'write' && caps.files.shell === 'on'),
      blockWritesOutsideWorkingDirectories: true,
      allow: [...files.allow, ...web],
    },
    ...files.sandbox,
  };
  return {
    t: 'enforcing',
    args: [
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--setting-sources',
      CLAUDE_SOURCES[caps.instructions],
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--tools',
      [...files.tools, ...web].join(','),
      ...files.addDirs.flatMap((dir) => ['--add-dir', dir]),
      '--settings',
      JSON.stringify(settings),
    ],
    report: {
      reads: files.reads,
      writes: ENFORCED,
      shell: ENFORCED,
      web: ENFORCED,
      agents: ENFORCED,
      schedule: ENFORCED,
      mcp: ENFORCED,
      instructions: ENFORCED,
    },
  };
}

export const claudeConfig: HarnessConfig = {
  binary: 'claude',
  baseCmd: [],
  bypassFlags: ['--dangerously-skip-permissions'],
  modelFlag: '--model',
  promptVia: 'flag',
  promptFlag: '-p',
  stdin: 'prompt',
  stdout: 'jsonl',
  mcpCapability: 'required',
  sessionCreateFlags: (id) => ['--session-id', id],
  sessionResumeFlags: (id) => ['--resume', id],
  // Fork: --resume <id> --fork-session assigns a new session id while
  // inheriting the original transcript (tool_use + tool_result blocks intact).
  // The original session is left untouched.
  sessionForkFlags: (id) => ['--resume', id, '--fork-session'],

  // Claude CLI accepts --effort <level> with choices:
  //   low | medium | high | xhigh | max
  // See `claude --help`. Flag is session-wide and works with -p/--print.
  reasoningFlags: (level) => ['--effort', level],

  envDefaults: {
    [CLAUDE_PRINT_BG_WAIT_CEILING_ENV]: String(CLAUDE_PRINT_BG_WAIT_CEILING_MS),
  },

  mcp: claudeMcpEncoding,
  capabilities: claudeCapabilities,
};
