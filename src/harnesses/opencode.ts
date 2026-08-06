import type { HarnessConfig } from '../types.ts';

/**
 * OpenCode CLI harness config.
 *
 * Session management:
 *   Create: implicit (session ID extracted from NDJSON output)
 *   Resume: --session <ses_xxx> --continue
 *   Guard: resume flags only emitted if session ID starts with 'ses_'
 *
 * Model normalization (κ — canonicalization):
 *   Legacy 'openai/...' → 'opencode/...' (backward compatibility)
 *   Bare 'muse-spark-*' → 'meta/muse-spark-*' (contributor preview via Meta API)
 *   Already-qualified 'meta/*' and 'opencode/*' pass through unchanged.
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
  sessionResumeFlags: (id) => (id.startsWith('ses_') ? ['--session', id, '--continue'] : []),

  // Fork: --session <id> --continue --fork inherits the transcript into a
  // new session id. Same ses_ prefix guard as resume.
  sessionForkFlags: (id) =>
    id.startsWith('ses_') ? ['--session', id, '--continue', '--fork'] : [],

  decomposeModel: (modelId) => {
    if (modelId.startsWith('openai/')) {
      return ['-m', `opencode/${modelId.slice('openai/'.length)}`];
    }
    if (modelId.startsWith('muse-spark')) {
      return ['-m', `meta/${modelId}`];
    }
    return ['-m', modelId];
  },
};
