import type { Harness, HarnessConfig, HarnessName } from '../types.ts';
import { claudeConfig } from './claude.ts';
import { codexConfig } from './codex.ts';
import { opencodeConfig } from './opencode.ts';
import { geminiConfig } from './gemini.ts';
import { cursorConfig } from './cursor.ts';

const geminiAliasPattern = /^gemini\d+$/;

/** Registry of all known harness configs. One entry per CLI agent. */
export const registry: Record<Harness, HarnessConfig> = {
  claude: claudeConfig,
  codex: codexConfig,
  opencode: opencodeConfig,
  gemini: geminiConfig,
  cursor: cursorConfig,
};

export function isGeminiAlias(name: string): name is Extract<HarnessName, `gemini${number}`> {
  return geminiAliasPattern.test(name);
}

export function canonicalizeHarness(name: HarnessName | string): Harness {
  return isGeminiAlias(name) ? 'gemini' : name as Harness;
}

/** Get a harness config by name. Throws on unknown harness. */
export function getHarness(name: HarnessName | string): HarnessConfig {
  const canonical = canonicalizeHarness(name);
  const config = registry[canonical as Harness];
  if (!config) {
    const known = Object.keys(registry).join(', ');
    throw new Error(`Unknown harness: "${name}". Known: ${known}`);
  }

  // Gemini aliases (gemini1/gemini2/gemini3) share CLI syntax but target
  // different binaries/wrappers so credentials stay isolated.
  if (name !== canonical) {
    return { ...config, binary: name };
  }

  return config;
}

/** List all known harness names. */
export function listHarnesses(): Harness[] {
  return Object.keys(registry) as Harness[];
}
