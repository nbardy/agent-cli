import type { UnifiedAgentEvent } from '../runtime-types.ts';
import type { Harness } from '../types.ts';
import { createClaudeParser } from './claude.ts';
import { parseCodex } from './codex.ts';
import { createCursorParser } from './cursor.ts';
import { parseGemini } from './gemini.ts';
import { parseMuse } from './muse.ts';
import { parseOpenCode } from './opencode.ts';

export type HarnessParser = (json: unknown) => UnifiedAgentEvent[];

export function createParser(harness: Harness): HarnessParser {
  switch (harness) {
    case 'claude':
      return createClaudeParser();
    case 'codex':
      return parseCodex;
    case 'opencode':
      return parseOpenCode;
    case 'gemini':
      return parseGemini;
    case 'cursor':
      return createCursorParser();
    case 'muse':
      return parseMuse;
  }
}
