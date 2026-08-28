import type { HarnessConfig, McpEncoding, McpServerSpec } from '../types.ts';

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
 * Claude has no per-server "required" knob. The harness-level `required`
 * capability therefore means that required servers are encoded in an explicit,
 * isolated process configuration; the caller still owns the Buddy tool contract.
 */
function claudeMcpEncoding(
  servers: Readonly<Record<string, McpServerSpec>>
): McpEncoding {
  const mcpServers: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.env) {
      for (const [key, value] of Object.entries(spec.env)) {
        if (key in env && env[key] !== value) {
          throw new Error(`MCP servers require conflicting values for environment variable ${key}`);
        }
        env[key] = value;
      }
    }
    mcpServers[name] = {
      command: spec.command,
      args: [...spec.args],
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    };
  }
  return {
    args: ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers })],
    ...(Object.keys(env).length > 0 ? { env } : {}),
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

  mcp: claudeMcpEncoding,
};
