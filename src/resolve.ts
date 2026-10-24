import { execFile, execSync } from 'node:child_process';

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

/**
 * Async twin of resolveBinary for callers that can await (boot audit: 8 serial `which` spawns
 * blocked the event loop). Same cache, same cursor fallbacks, same error.
 */
export async function resolveBinaryAsync(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached) return cached;
  for (const candidate of [name, ...(CURSOR_FALLBACKS[name] ?? [])]) {
    const p = await new Promise<string>((resolve) =>
      execFile('which', [candidate], { encoding: 'utf-8' }, (err, out) =>
        resolve(err ? '' : out.trim())
      )
    );
    if (!p) continue;
    cache.set(name, p);
    if (candidate !== name) cache.set(candidate, p);
    return p;
  }
  throw new Error(`Binary not found on PATH: ${name}`);
}
