import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardedMcpEnv } from './mcp-env.ts';
import type { McpServerSpec } from './types.ts';

/**
 * Muse MCP injection through a merged settings file.
 *
 * The muse CLI takes no MCP argv (unlike claude/codex) and no MCP env
 * (unlike opencode). Its only MCP surface is the `mcp_servers` block of the
 * user settings file (`$XDG_CONFIG_HOME/muse/settings.json`, else
 * `~/.config/muse/settings.json`). This module is the harness-owned HOW for
 * that surface: merge canonical server specs into a copy of the user's
 * settings and point the child at it via XDG_CONFIG_HOME.
 *
 * Fail-closed preserved: entries are written with explicit `mode`
 * (`required` when the spec demands it, `optional` otherwise) and the CLI
 * aborts the whole run when a required server fails startup. Verified
 * empirically against the installed binary: a nonexistent required command
 * ends the run with `run.terminal.failed` before any model step.
 *
 * Residue tradeoff: server args embed per-conversation ids, so the merged
 * dir is content-addressed (same content rewrites the same dir, concurrent
 * turns never share a path). Distinct server sets accumulate ~1KB dirs under
 * os.tmpdir(); they hold secrets (control tokens) with 0600/0700 modes.
 */

export interface MuseMcpConfigDir {
  /** Value to set XDG_CONFIG_HOME to for the child process. */
  readonly baseDir: string;
  /** Absolute path of the merged settings.json (for tests). */
  readonly settingsPath: string;
}

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
  const userServers =
    typeof userSettings['mcp_servers'] === 'object' && userSettings['mcp_servers'] !== null
      ? (userSettings['mcp_servers'] as Record<string, unknown>)
      : {};

  const mergedServers: Record<string, unknown> = { ...userServers };
  // The CLI gives MCP servers exactly the env declared here (no parent
  // inheritance observed), so parent-scoped store selection must be
  // forwarded explicitly or the child silently opens the default store.
  const forwardedEnv = forwardedMcpEnv();
  for (const [name, spec] of Object.entries(servers)) {
    const encoded = {
      transport: 'stdio',
      command: spec.command,
      args: [...spec.args],
      ...(Object.keys(forwardedEnv).length > 0 || spec.env
        ? { env: { ...forwardedEnv, ...spec.env } }
        : {}),
      enabled: true,
      mode: spec.required ? 'required' : 'optional',
    };
    const existing = mergedServers[name];
    if (existing !== undefined && stableStringify(existing) !== stableStringify(encoded)) {
      throw new Error(
        `Muse MCP encoding refuses to shadow the user's own "${name}" server with a different spec`
      );
    }
    mergedServers[name] = encoded;
  }

  const mergedSettings: Record<string, unknown> = {
    ...userSettings,
    schema_version: 1,
    mcp_servers: mergedServers,
  };
  const digest = createHash('sha256').update(stableStringify(mergedSettings)).digest('hex').slice(0, 16);
  const baseDir = join(tmpdir(), 'unleashd-muse-mcp', digest);
  const generatedRoot = join(baseDir, 'muse');
  mkdirSync(generatedRoot, { recursive: true, mode: 0o700 });

  // Mirror the user's config entries (auth, trust, skills, hooks) so the
  // XDG redirect hides nothing. settings.json is the merged copy, not a link.
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (entry === 'settings.json') continue;
      const target = join(generatedRoot, entry);
      try {
        unlinkSync(target);
      } catch {
        // Absent (or dangling from a removed user file); relink below.
      }
      symlinkSync(join(root, entry), target);
    }
  }

  const settingsPath = join(generatedRoot, 'settings.json');
  writeFileSync(settingsPath, `${JSON.stringify(mergedSettings, null, 2)}\n`, { mode: 0o600 });
  return { baseDir, settingsPath };
}
