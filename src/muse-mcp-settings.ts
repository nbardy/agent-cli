import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type McpKindEncoders, encodeMcpServers } from './mcp-encoding.ts';
import { forwardedMcpEnv } from './mcp-env.ts';
import type { McpServerSpec } from './types.ts';

/**
 * Muse MCP injection through a merged settings file.
 *
 * The muse CLI takes no MCP argv (unlike claude/codex) and no MCP env
 * (unlike opencode). Its only MCP surface is the `mcpServers` block of the
 * user settings file (`$XDG_CONFIG_HOME/muse/settings.json`, else
 * `~/.config/muse/settings.json`). This module is the harness-owned HOW for
 * that surface: merge canonical server specs into a copy of the user's
 * settings and point the child at it via XDG_CONFIG_HOME.
 *
 * Key: `mcpServers` (camelCase) with `type:"stdio"` / `type:"streamable-http"`
 * entries. Muse 1.4.0 documents this shape (its bundled migrate skill) and
 * DROPS THE WHOLE MCP MEMBER when both `mcpServers` and the legacy
 * `mcp_servers` are present. A legacy user block is therefore folded into
 * `mcpServers` and the legacy key is never written. (Bug B5: this encoder used
 * to write `mcp_servers` + `transport`.)
 *
 * Fail-closed preserved: entries carry an explicit `mode` (`required` when the
 * spec demands it, `optional` otherwise). Never also write `required`; muse
 * treats the pair as an ambiguous alias and drops the member. The CLI aborts
 * the run when a required server fails startup. Verified 2026-09-25 against
 * muse 1.4.0 with `--provider echo` (no model call): a streamable-HTTP entry
 * with a wrong bearer ended the run with `run.terminal.failed` ("MCP server
 * `probe` failed during startup: authentication failed"); the right bearer
 * reached initialize + tools/list.
 *
 * Muse does not expand `${VAR}`, so HTTP header values are written LITERALLY.
 * The dir is therefore per-invocation (mkdtemp; dir 0700, file 0600) and is
 * returned for `ownedPaths`: runCommand deletes it when the child exits, so a
 * per-turn token never outlives its run on disk.
 */

export interface MuseMcpConfigDir {
  /** Value to set XDG_CONFIG_HOME to for the child process. */
  readonly baseDir: string;
  /** Absolute path of the merged settings.json (for tests). */
  readonly settingsPath: string;
}

type MuseEntry = Record<string, unknown>;

const museMcpEncoders: McpKindEncoders<MuseEntry> = {
  // The CLI gives MCP servers exactly the env declared here (no parent
  // inheritance observed), so parent-scoped store selection must be
  // forwarded explicitly or the child silently opens the default store.
  // Muse has no stdio `cwd` (its migrate skill drops Codex `cwd`).
  stdio: (_name, spec) => {
    const env = { ...forwardedMcpEnv(), ...spec.env };
    return {
      entry: {
        type: 'stdio',
        command: spec.command,
        args: [...spec.args],
        ...(Object.keys(env).length > 0 ? { env } : {}),
        enabled: true,
        mode: spec.required ? 'required' : 'optional',
      },
      env: {},
    };
  },
  http: (_name, spec) => ({
    entry: {
      type: 'streamable-http',
      url: spec.url,
      headers: { ...spec.headers },
      enabled: true,
      mode: spec.required ? 'required' : 'optional',
    },
    env: {},
  }),
};

/** Where this process's muse CLI reads user configuration. */
export function museConfigRoot(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(process.env.HOME ?? homedir(), '.config');
  return join(base, 'muse');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function readUserSettings(root: string): Record<string, unknown> {
  const path = join(root, 'settings.json');
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (error) {
    throw new Error(
      `Muse MCP encoding refuses to merge with unparseable settings at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Muse settings at ${path} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function objectMember(settings: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = settings[key];
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Muse settings member "${key}" must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** The user's servers, with a legacy `mcp_servers` block folded into `mcpServers`. */
function userMcpServers(settings: Record<string, unknown>): Record<string, unknown> {
  const legacy = objectMember(settings, 'mcp_servers');
  const current = objectMember(settings, 'mcpServers');
  for (const name of Object.keys(legacy)) {
    if (name in current && stableStringify(current[name]) !== stableStringify(legacy[name])) {
      throw new Error(
        `Muse settings define "${name}" differently under mcpServers and legacy mcp_servers`
      );
    }
  }
  return { ...legacy, ...current };
}

/**
 * Materialize a merged muse config dir for these servers and return the
 * XDG base to spawn with. Synchronous: called from buildCommand, which is
 * already a sync factory (same constraint as fork-emulation).
 */
export function buildMuseMcpConfigDir(
  servers: Readonly<Record<string, McpServerSpec>>
): MuseMcpConfigDir {
  const root = museConfigRoot();
  const userSettings = readUserSettings(root);
  const mergedServers = userMcpServers(userSettings);
  for (const [name, encoded] of encodeMcpServers(museMcpEncoders, servers).entries) {
    const existing = mergedServers[name];
    if (existing !== undefined && stableStringify(existing) !== stableStringify(encoded)) {
      throw new Error(
        `Muse MCP encoding refuses to shadow the user's own "${name}" server with a different spec`
      );
    }
    mergedServers[name] = encoded;
  }

  const { mcp_servers: _legacy, ...userSettingsWithoutLegacy } = userSettings;
  const mergedSettings: Record<string, unknown> = {
    ...userSettingsWithoutLegacy,
    schema_version: 1,
    mcpServers: mergedServers,
  };
  const baseDir = mkdtempSync(join(tmpdir(), 'unleashd-muse-mcp-'));
  chmodSync(baseDir, 0o700);
  const generatedRoot = join(baseDir, 'muse');
  mkdirSync(generatedRoot, { mode: 0o700 });

  // Mirror the user's config entries (auth, trust, skills, hooks) so the
  // XDG redirect hides nothing. settings.json is the merged copy, not a link.
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (entry === 'settings.json') continue;
      symlinkSync(join(root, entry), join(generatedRoot, entry));
    }
  }

  const settingsPath = join(generatedRoot, 'settings.json');
  writeFileSync(settingsPath, `${JSON.stringify(mergedSettings, null, 2)}\n`, { mode: 0o600 });
  return { baseDir, settingsPath };
}
