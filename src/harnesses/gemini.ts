import type { HarnessConfig } from '../types.ts';
import { emulateForkGemini } from '../fork-emulation.ts';

/**
 * Gemini CLI harness config.
 *
 * Session management:
 *   Gemini supports UUID-based resume: --resume <session-uuid>.
 *   Using the actual session ID avoids collisions when multiple
 *   conversations share the same working directory (--resume latest
 *   would always resume the most recent one, causing fights).
 *
 * Permissions:
 *   --yolo bypasses all confirmation prompts.
 */
export const geminiConfig: HarnessConfig = {
  binary: 'gemini',
  baseCmd: [],
  bypassFlags: ['--yolo'],
  modelFlag: '-m',
  promptVia: 'flag',
  promptFlag: '-p',
  stdin: 'close',
  stdout: 'jsonl',

  // Gemini accepts UUIDs for --resume (not just "latest").
  // Using the actual session ID prevents two conversations with the
  // same CWD from fighting over a single session.
  sessionResumeFlags: (id) => ['--resume', id],

  // Gemini has no --fork equivalent — `--resume` mutates the original
  // session. We fork by copying the session file under
  // ~/.gemini/tmp/<projectHash>/chats/ to a fresh uuid (rewriting the
  // top-level sessionId), then --resume the copy. See fork-emulation.ts.
  emulateFork: (sourceSessionId) => emulateForkGemini(sourceSessionId),
};
