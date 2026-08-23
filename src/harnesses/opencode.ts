import type { HarnessConfig, McpEncoding, McpServerSpec } from '../types.ts';

/**
 * OpenCode CLI harness config.
 *
 * Session management:
 *   Create: implicit (session ID extracted from NDJSON output)
 *   Resume: --session <ses_xxx> --continue
 *   Guard: resume flags only emitted if session ID starts with 'ses_'
 *
 * Model normalization (κ — canonicalization):
 *   Legacy 'openai/...' → 'opencode/...' (backward compatibility)
 *   Bare 'muse-spark-*' → 'meta/muse-spark-*' (contributor preview via Meta API)
 *   Already-qualified 'meta/*' and 'opencode/*' pass through unchanged.
 */
/**
 * OpenCode has NO MCP command-line flag. Config arrives through the
 * OPENCODE_CONFIG_CONTENT env var as an inline JSON document — which is why
 * this encoder returns `env` and not `args`, and why the caller (unleashd)
 * could never implement this itself: only the spawn site can set env.
 *
 * Verified empirically on 2026-08-21 against the installed binary:
 *   - the server is loaded and dialed (`opencode mcp list` shows it, failing
 *     only because the probe command was not a real MCP server);
 *   - `cwd` IS honored — a probe server wrote its own pwd and it matched the
 *     configured cwd, not the process cwd;
 *   - the content MERGES with ~/.config/opencode/opencode.json rather than
 *     replacing it (the user's custom `meta` provider models survived), so
 *     this satisfies the additive-encoder rule.
 * OpenCode ignores unknown keys silently, so a schema typo will NOT error —
 * re-probe behaviourally rather than trusting acceptance.
 *
 * Shape differs from claude's: `command` is ONE array (binary followed by its
 * args), not split command/args. There is no per-server "required" knob, so
 * `spec.required` cannot be honored.
 *
 * Caveat: this OVERWRITES any OPENCODE_CONFIG_CONTENT already in the
 * environment. Nothing in this repo sets it; a caller that does would lose it.
 */
function opencodeMcpEncoding(servers: Readonly<Record<string, McpServerSpec>>): McpEncoding {
  const mcp: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers)) {
    mcp[name] = {
      type: 'local',
      command: [spec.command, ...spec.args],
      enabled: true,
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      ...(spec.env ? { environment: spec.env } : {}),
    };
  }
  return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) } };
}

export const opencodeConfig: HarnessConfig = {
  binary: 'opencode',
  baseCmd: ['run'],
  // `opencode run --auto` = "auto-approve permissions that are not explicitly
  // denied". This was the only harness with an empty bypassFlags, so a caller
  // passing yolo/bypassPermissions got silent no-op and opencode still gated on
  // its interactive permission prompt — with no TTY to answer it.
  bypassFlags: ['--auto'],
  modelFlag: '-m',
  promptVia: 'cli-arg',
  stdin: 'close',
  stdout: 'jsonl',
  mcpCapability: 'inject',

  // Only resume if the session ID has the expected ses_ prefix
  sessionResumeFlags: (id) => (id.startsWith('ses_') ? ['--session', id, '--continue'] : []),

  // Fork: --session <id> --continue --fork inherits the transcript into a
  // new session id. Same ses_ prefix guard as resume.
  sessionForkFlags: (id) =>
    id.startsWith('ses_') ? ['--session', id, '--continue', '--fork'] : [],

  decomposeModel: (modelId) => {
    if (modelId.startsWith('openai/')) {
      return ['-m', `opencode/${modelId.slice('openai/'.length)}`];
    }
    if (modelId.startsWith('muse-spark')) {
      return ['-m', `meta/${modelId}`];
    }
    return ['-m', modelId];
  },

  mcp: (servers) => opencodeMcpEncoding(servers),
};
