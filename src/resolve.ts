import { execSync } from 'node:child_process';

/**
 * Cache of resolved binary paths. Module-level for process lifetime caching.
 * Key: binary name, Value: absolute path.
 */
const cache = new Map<string, string>();

/**
 * Resolve a binary name to its absolute path via `which`.
 *
 * Caches results for the process lifetime. Throws if the binary
 * is not found on PATH.
 *
 * Why: babashka's ProcessBuilder with :dir can fail to find bare
 * command names on macOS. Resolving once via `which` and using
 * the absolute path avoids this issue.
 */
const CURSOR_FALLBACKS: Record<string, string[]> = {
  agent: ['cursor-agent'],
  'cursor-agent': ['agent'],
};

export function resolveBinary(name: string): string {
  const cached = cache.get(name);
  if (cached) return cached;

  const candidates = [name, ...(CURSOR_FALLBACKS[name] ?? [])];
  for (const candidate of candidates) {
    try {
      const p = execSync(`which ${candidate}`, { encoding: 'utf-8' }).trim();
      if (!p) continue;
      // Cache under requested name so future lookups don't re-probe fallback.
      cache.set(name, p);
      if (candidate !== name) cache.set(candidate, p);
      return p;
    } catch {
      // try fallback
    }
  }
  throw new Error(`Binary not found on PATH: ${name}`);
}
