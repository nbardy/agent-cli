import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardedMcpEnv } from './mcp-env.ts';
import type { McpServerSpec } from './types.ts';

/**
 * Cursor MCP injection through a local plugin directory.
 *
 * `agent` reads MCP servers only from `.cursor/mcp.json` (project) and
 * `~/.cursor/mcp.json` (user) — no argv, no env. Writing either would mutate
 * the user's repository or home. `--plugin-dir <path>` loads one local plugin
 * for THIS process only, and a plugin may ship its own `.mcp.json`; that is
 * the per-process surface. Additive: the user's own servers still load.
 *
 * Verified against agent 2026.08.11-e8db854 (2026-09-24):
 *   - the server is spawned eagerly, before any tool call;
 *   - `cwd` is honored; env is SCRUBBED to HOME/LOGNAME/PATH/SHELL/TERM/USER,
 *     so everything the server needs is written into its entry;
 *   - tool calls need `--approve-mcps` to load and `--force` to execute — a
 *     print-mode call without `--force` is auto-rejected ("User rejected MCP");
 *   - the server is exposed as `plugin-<plugin dir basename>-<server name>`,
 *     which is why the basename is the fixed CURSOR_MCP_PLUGIN_NAME and the
 *     parser strips CURSOR_MCP_PROVIDER_PREFIX back to the canonical name;
 *   - a server that fails to start is DROPPED SILENTLY and the turn succeeds.
 *     Fail-closed therefore comes from the runner's own startup probe
 *     (mcp-startup.ts), not from the CLI.
 *
 * Content-addressed like the muse settings dir: server args embed
 * per-conversation ids and env carries control tokens, so the file is 0600
 * under a 0700 dir and concurrent turns never share a path.
 */
export const CURSOR_MCP_PLUGIN_NAME = 'agent-cli';
export const CURSOR_MCP_PROVIDER_PREFIX = `plugin-${CURSOR_MCP_PLUGIN_NAME}-`;

export function buildCursorMcpPluginDir(servers: Readonly<Record<string, McpServerSpec>>): string {
  const inherited = forwardedMcpEnv();
  const mcpServers: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers)) {
    mcpServers[name] = {
      command: spec.command,
      args: [...spec.args],
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env: { ...inherited, ...spec.env },
    };
  }
  const content = `${JSON.stringify({ mcpServers }, null, 2)}\n`;
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 16);
  const pluginDir = join(tmpdir(), 'unleashd-cursor-mcp', digest, CURSOR_MCP_PLUGIN_NAME);
  mkdirSync(join(pluginDir, '.cursor-plugin'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(pluginDir, '.cursor-plugin', 'plugin.json'),
    `${JSON.stringify({ name: CURSOR_MCP_PLUGIN_NAME })}\n`
  );
  writeFileSync(join(pluginDir, '.mcp.json'), content, { mode: 0o600 });
  return pluginDir;
}
