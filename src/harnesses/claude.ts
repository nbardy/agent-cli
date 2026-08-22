import type { HarnessConfig, McpServerSpec } from '../types.ts';

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
 * Deliberately NO `--strict-mcp-config`: that flag makes claude ignore every
 * other MCP configuration, so an injected server would silently evict the
 * user's own workspace servers. Codex's `-c` overlay is additive and this must
 * match — see HarnessConfig.mcp.
 *
 * Claude's schema has no per-server "required" knob, so `spec.required` cannot
 * be honored here; claude starts the turn even if the server fails to boot.
 */
function claudeMcpArgs(servers: Readonly<Record<string, McpServerSpec>>): string[] {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers)) {
    mcpServers[name] = {
      command: spec.command,
      args: [...spec.args],
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    };
  }
  return ['--mcp-config', JSON.stringify({ mcpServers })];
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

  mcp: (servers) => ({ args: claudeMcpArgs(servers) }),
};
