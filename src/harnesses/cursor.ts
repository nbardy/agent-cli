import type { HarnessConfig } from '../types.ts';

/**
 * Cursor Agent CLI harness.
 *
 * Binary migrated from `cursor-agent` to `agent` (symlink
 * vendor 2026.08.04-aaa8809/cursor-agent → agent on PATH). New CLI help
 * (`agent --help`) lists `agent` as the headless entrypoint; flags are
 * identical: --print --output-format stream-json --stream-partial-output,
 * --model, --resume <id>, -f/--force/--yolo, --trust, --sandbox, --add-dir,
 * --worktree etc. No `agent exec` subcommand — headless is `agent` itself
 * with options (unlike `codex exec`). Resume uses `--resume <chatId>` (also
 * supports bare `--continue` for "latest", but harness always passes explicit
 * id via --resume). --force (-f) / --yolo are equivalent bypass; harness
 * prefers long-form --force. --trust/--sandbox/--add-dir/--worktree are
 * workspace-policy flags passed via extraArgs when needed, not baseCmd.
 * Fallback to `cursor-agent` is handled in resolveBinary/process-runner.
 *
 * No sessionForkFlags / emulateFork: Cursor absent from FORK_CAPABLE_PROVIDERS.
 */
export const cursorConfig: HarnessConfig = {
  binary: 'agent',
  baseCmd: ['--print', '--output-format', 'stream-json', '--stream-partial-output'],
  bypassFlags: ['--force'],
  modelFlag: '--model',
  promptVia: 'cli-arg',
  stdin: 'close',
  stdout: 'jsonl',

  sessionResumeFlags: (id) => ['--resume', id],
};
