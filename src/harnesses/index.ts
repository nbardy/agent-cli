import { reportOf } from '../capabilities.ts';
import type {
  CapabilityEncoding,
  CapabilityReport,
  Harness,
  HarnessConfig,
  HarnessName,
  McpCapability,
  TurnCapabilities,
} from '../types.ts';
import { claudeConfig } from './claude.ts';
import { codexConfig } from './codex.ts';
import { cursorConfig } from './cursor.ts';
import { geminiConfig } from './gemini.ts';
import { museConfig } from './muse.ts';
import { piConfig } from './pi.ts';
import { opencodeConfig } from './opencode.ts';

const geminiAliasPattern = /^gemini\d+$/;

/** Registry of all known harness configs. One entry per CLI agent. */
export const registry: Record<Harness, HarnessConfig> = {
  claude: claudeConfig,
  codex: codexConfig,
  opencode: opencodeConfig,
  gemini: geminiConfig,
  cursor: cursorConfig,
  muse: museConfig,
  pi: piConfig,
};

export function isGeminiAlias(name: string): name is Extract<HarnessName, `gemini${number}`> {
  return geminiAliasPattern.test(name);
}

export function canonicalizeHarness(name: HarnessName | string): Harness {
  return isGeminiAlias(name) ? 'gemini' : (name as Harness);
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

/** Whether this harness can encode canonical per-process MCP server specs. */
export function harnessSupportsMcp(name: HarnessName | string): boolean {
  return getHarness(name).mcpCapability !== 'none';
}

/** The harness's own flags for a capability set (types.ts `TurnCapabilities`). */
export function encodeCapabilities(
  name: HarnessName | string,
  caps: TurnCapabilities
): CapabilityEncoding {
  return getHarness(name).capabilities(caps);
}

/**
 * Which capabilities `name` enforces for `caps`, and which it can only be told: what a launch
 * preview shows before anything runs. Pure; nothing is spawned.
 */
export const capabilityReport = (
  name: HarnessName | string,
  caps: TurnCapabilities
): CapabilityReport => reportOf(encodeCapabilities(name, caps));

/** Distinguishes best-effort injection from enforceable, fail-closed MCP. */
export function harnessMcpCapability(name: HarnessName | string): McpCapability {
  return getHarness(name).mcpCapability;
}
