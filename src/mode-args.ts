import type { TurnMode } from './runtime-types.ts';
import type { Harness } from './types.ts';

/**
 * The opt-in `fullAuto` request option means "unattended but still sandboxed",
 * the softer sibling of bypassPermissions (which pushes
 * `--dangerously-bypass-approvals-and-sandbox` and removes the sandbox too).
 *
 * It used to emit `--full-auto`. That flag no longer exists on any `codex`
 * subcommand — verified against Codex CLI 2026-08: `codex --help` and
 * `codex exec --help` both report zero occurrences. `codex exec` is already
 * non-interactive, so there is no approval prompt to suppress; the sandbox
 * policy is the only remaining control, and `workspace-write` is the mode that
 * matches the old flag's behaviour.
 */
const CODEX_FULL_AUTO_ARGS = ['-s', 'workspace-write'] as const;

export function buildModeExtraArgs(
  harness: Harness,
  mode: TurnMode,
  yolo: boolean,
  cwd: string,
  codexFullAuto: boolean
): readonly string[] {
  if (mode === 'single-shot') {
    switch (harness) {
      case 'claude':
        return ['-p', '--output-format', 'text'];
      case 'gemini':
        return ['--output-format', 'text'];
      case 'codex':
        return codexFullAuto ? [...CODEX_FULL_AUTO_ARGS] : [];
      default:
        return [];
    }
  }

  switch (harness) {
    case 'claude': {
      const args = [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
      ];
      if (yolo)
        args.push('--permission-mode', 'bypassPermissions', '--tools', 'default', '--add-dir', cwd);
      return args;
    }
    case 'codex':
      return codexFullAuto ? [...CODEX_FULL_AUTO_ARGS, '--json'] : ['--json'];
    case 'gemini':
      return ['--output-format', 'stream-json'];
    case 'opencode':
      return ['--format', 'json'];
    case 'cursor':
      return [];
    case 'muse':
      return ['--json'];
  }
}
