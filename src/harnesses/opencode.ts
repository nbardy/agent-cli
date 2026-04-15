import type { HarnessConfig } from '../types.ts';

/**
 * OpenCode CLI harness config.
 *
 * Session management:
 *   Create: implicit (session ID extracted from NDJSON output)
 *   Resume: --session <ses_xxx> --continue
 *   Guard: resume flags only emitted if session ID starts with 'ses_'
 *
 * Model normalization:
 *   Legacy 'openai/...' format → 'opencode/...' (backward compatibility)
 */
export const opencodeConfig: HarnessConfig = {
  binary: 'opencode',
  baseCmd: ['run'],
  bypassFlags: [],
  modelFlag: '-m',
  promptVia: 'cli-arg',
  stdin: 'close',
  stdout: 'jsonl',

  // Only resume if the session ID has the expected ses_ prefix
  sessionResumeFlags: (id) =>
    id.startsWith('ses_') ? ['--session', id, '--continue'] : [],

  // Fork: --session <id> --continue --fork inherits the transcript into a
  // new session id. Same ses_ prefix guard as resume.
  sessionForkFlags: (id) =>
    id.startsWith('ses_') ? ['--session', id, '--continue', '--fork'] : [],

  decomposeModel: (modelId) => {
    // Legacy format normalization: openai/ → opencode/
    const normalized = modelId.startsWith('openai/')
      ? `opencode/${modelId.slice('openai/'.length)}`
      : modelId;
    return ['-m', normalized];
  },
};
