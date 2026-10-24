import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a binary name to its absolute path. Throws if it is not executable on PATH.
 *
 * Why: babashka's ProcessBuilder with :dir can fail to find bare
 * command names on macOS. Resolving before launch and using
 * the absolute path avoids this issue.
 */
const CURSOR_FALLBACKS: Record<string, string[]> = {
  agent: ['cursor-agent'],
  'cursor-agent': ['agent'],
};

export function resolveBinary(name: string): string {
  return resolveCommandBinary(name, process.cwd(), process.env);
}

// Pattern: fix-guards (docs/patterns.md#fix-guards)
// A process-lifetime cache kept running the old CLI after PATH changed (or it was removed).
// Probe the launch's env/cwd without a `which` subprocess. Guard: launch-classification.test.ts.
export function resolveCommandBinary(name: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const candidates = [name, ...(CURSOR_FALLBACKS[name] ?? [])];
  for (const candidate of candidates) {
    const paths = candidate.includes('/')
      ? [path.resolve(cwd, candidate)]
      : (env.PATH ?? '/usr/bin:/bin')
          .split(path.delimiter)
          .map((dir) => path.resolve(cwd, dir, candidate));
    for (const resolved of paths) {
      try {
        accessSync(resolved, constants.X_OK);
        if (statSync(resolved).isFile()) return resolved;
      } catch {
        // Another PATH entry or the Cursor fallback may be executable.
      }
    }
  }
  throw new Error(`Binary not found on PATH: ${name}`);
}
