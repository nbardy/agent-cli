import fs from 'node:fs';

import { findCodexSessionFile } from './fork-emulation.ts';

export interface NativeSessionProgress {
  available: boolean;
  advanced: boolean;
  silentSeconds: number;
  sizeBytes?: number;
}

interface NativeProgressRuntime {
  now?: () => number;
  sessionsRoot?: string;
}

/**
 * Observe Codex rollout progress using filesystem metadata only.
 *
 * This deliberately never opens or reads the rollout. Its only inputs are the
 * resolved session id, directory entry names, and stat metadata, so reasoning,
 * prompts, tool inputs, and model output cannot leak through diagnostics.
 */
export function createCodexNativeProgressProbe(
  sessionId: string,
  runtime: NativeProgressRuntime = {}
): { poll: () => NativeSessionProgress } {
  const now = runtime.now ?? Date.now;
  const file = findCodexSessionFile(sessionId, runtime.sessionsRoot);
  let initialStat: fs.Stats | undefined;
  if (file) {
    try {
      initialStat = fs.statSync(file);
    } catch {}
  }
  let lastSize = initialStat?.size;
  let lastMtimeMs = initialStat?.mtimeMs;
  let lastAdvanceAt = now();

  return {
    poll(): NativeSessionProgress {
      if (!file) {
        return {
          available: false,
          advanced: false,
          silentSeconds: Math.max(0, Math.round((now() - lastAdvanceAt) / 1000)),
        };
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        return {
          available: false,
          advanced: false,
          silentSeconds: Math.max(0, Math.round((now() - lastAdvanceAt) / 1000)),
        };
      }

      const established = lastSize !== undefined && lastMtimeMs !== undefined;
      const advanced = established && (stat.size !== lastSize || stat.mtimeMs !== lastMtimeMs);
      if (advanced) lastAdvanceAt = now();
      lastSize = stat.size;
      lastMtimeMs = stat.mtimeMs;

      return {
        available: true,
        advanced,
        silentSeconds: Math.max(0, Math.round((now() - lastAdvanceAt) / 1000)),
        sizeBytes: stat.size,
      };
    },
  };
}
