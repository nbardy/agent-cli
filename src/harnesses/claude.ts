import { type McpKindEncoders, encodeMcpServers, headersViaEnv } from '../mcp-encoding.ts';
import type { HarnessConfig, McpEncoding, McpServerSpec } from '../types.ts';

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
};
