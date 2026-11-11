import { unenforced } from '../capabilities.ts';
import { buildPiMcpExtension } from '../pi-mcp.ts';
import type { HarnessConfig } from '../types.ts';

export const PI_RESTRICTED_FLAGS = [
  '--no-session', '--no-tools', '--no-mcp', '--no-context-files', '--no-skills', '--no-prompt-templates',
] as const;

// Pattern: table-driven (docs/patterns.md#table-driven)
// Pi owns model auth, sessions and codemode. The pinned SoL-Pi package changes
// its tools/context through public extensions, never a second agent runner.
export const piConfig: HarnessConfig = {
  // No capability mapping yet: a capability turn here runs unrestricted, reported advisory.
  capabilities: unenforced('pi'),
  binary: 'sol-pi',
  baseCmd: [],
  bypassFlags: [],
  modelFlag: '--model',
  promptVia: 'stdin',
  stdin: 'prompt',
  stdout: 'jsonl',
  sessionCreateFlags: (id) => ['--session-id', id],
  sessionResumeFlags: (id) => ['--session', id],
  sessionForkFlags: (id) => ['--fork', id],
  reasoningFlags: (level) => ['--thinking', level],
  mcpCapability: 'required',
  guardsRequiredMcpStartup: true,
  mcp: buildPiMcpExtension,
};
