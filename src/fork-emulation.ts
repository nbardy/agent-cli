import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Fork emulation for providers whose CLI has no native non-interactive
 * `--fork` flag. The technique: locate the source session file on disk,
 * COPY it to a fresh uuid, rewrite the internal session-id field so the
 * copy is self-consistent, and return the new id. The caller then spawns
 * the provider with `resume: true` on the copy.
 *
 * The source file is never touched — this is a true fork, not a rename.
 *
 * Synchronous on purpose: executeCommand is a synchronous factory
 * (returns a handle immediately, spawn happens eagerly). Session files
 * are small enough that sync fs I/O is acceptable here.
 *
 * Currently implemented:
 *   - codex   → ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *                (rewrites payload.id on the first session_meta line)
 *   - gemini  → ~/.gemini/tmp/<projectHash>/chats/session-<ts>-<uuid>.json
 *                (rewrites top-level sessionId field)
 */

// Read $HOME fresh each call so tests can override via process.env.HOME
// without reaching into the module state. Production callers don't mutate
// HOME, so this costs nothing and keeps the module itself side-effect-free
// at import time.
const codexSessionsDir = () => path.join(os.homedir(), '.codex', 'sessions');
const geminiSessionsDir = () => path.join(os.homedir(), '.gemini', 'tmp');
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export type EmulatedForkResult = {
  newSessionId: string;
  newFilePath: string;
  sourceFilePath: string;
};

export type EmulatedHarness = 'codex' | 'gemini';

// Called by executeCommand when a fork is requested against a harness whose
// CLI has no native --fork flag. Returns the new session id to --resume.
// Harnesses with a native fork flag never reach this code path.
export function emulateFork(harness: EmulatedHarness, sourceSessionId: string): EmulatedForkResult {
  if (harness === 'codex') return emulateForkCodex(sourceSessionId);
  if (harness === 'gemini') return emulateForkGemini(sourceSessionId);
  throw new Error(`emulateFork: unsupported harness ${harness}`);
}

export function emulateForkCodex(sourceSessionId: string): EmulatedForkResult {
  const sourceFilePath = findCodexSessionFile(sourceSessionId);
  if (!sourceFilePath) {
    throw new Error(`Codex session file not found for id ${sourceSessionId}`);
  }

  const newSessionId = randomUUID();
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const destDir = path.join(codexSessionsDir(), yyyy, mm, dd);
  fs.mkdirSync(destDir, { recursive: true });
  const tsStamp = now.toISOString().replace(/[:.]/g, '-');
  const newFilePath = path.join(destDir, `rollout-${tsStamp}-${newSessionId}.jsonl`);

  const raw = fs.readFileSync(sourceFilePath, 'utf-8');
  const lines = raw.split('\n');
  let metaRewritten = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!metaRewritten && isCodexSessionMeta(entry)) {
      const payload = { ...(entry.payload as Record<string, unknown>), id: newSessionId };
      const rewritten = { ...entry, payload };
      lines[i] = JSON.stringify(rewritten);
      metaRewritten = true;
    }
  }
  if (!metaRewritten) {
    throw new Error(`Codex source file lacks session_meta: ${sourceFilePath}`);
  }
  fs.writeFileSync(newFilePath, lines.join('\n'));

  return { newSessionId, newFilePath, sourceFilePath };
}

export function emulateForkGemini(sourceSessionId: string): EmulatedForkResult {
  const sourceFilePath = findGeminiSessionFile(sourceSessionId);
  if (!sourceFilePath) {
    throw new Error(`Gemini session file not found for id ${sourceSessionId}`);
  }

  const newSessionId = randomUUID();
  const destDir = path.dirname(sourceFilePath);
  const tsStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const newFilePath = path.join(destDir, `session-${tsStamp}-${newSessionId}.json`);

  const raw = fs.readFileSync(sourceFilePath, 'utf-8');
  const data = JSON.parse(raw) as Record<string, unknown>;
  data.sessionId = newSessionId;
  fs.writeFileSync(newFilePath, JSON.stringify(data, null, 2));

  return { newSessionId, newFilePath, sourceFilePath };
}

// --- internal: filesystem search --------------------------------------------

function findCodexSessionFile(sessionId: string): string | null {
  try {
    const years = listDirs(codexSessionsDir());
    for (const y of years) {
      const months = listDirs(y);
      for (const m of months) {
        const days = listDirs(m);
        for (const d of days) {
          let files: string[];
          try {
            files = fs.readdirSync(d);
          } catch {
            continue;
          }
          for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const match = f.match(UUID_RE);
            if (match && match[1].toLowerCase() === sessionId.toLowerCase()) {
              return path.join(d, f);
            }
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function findGeminiSessionFile(sessionId: string): string | null {
  try {
    const projectDirs = listDirs(geminiSessionsDir());
    for (const proj of projectDirs) {
      const chats = path.join(proj, 'chats');
      let files: string[];
      try {
        files = fs.readdirSync(chats);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.startsWith('session-') || !f.endsWith('.json')) continue;
        const match = f.match(UUID_RE);
        if (match && match[1].toLowerCase() === sessionId.toLowerCase()) {
          return path.join(chats, f);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function listDirs(parent: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(parent, e.name));
}

function isCodexSessionMeta(
  entry: unknown
): entry is { type: string; payload: { id: string } & Record<string, unknown> } {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { type?: unknown; payload?: unknown };
  if (e.type !== 'session_meta') return false;
  const p = e.payload;
  return !!p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string';
}
