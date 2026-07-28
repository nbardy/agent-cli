import type { TurnMode } from './runtime-types.ts';
import type { Harness } from './types.ts';

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
        return codexFullAuto ? ['--full-auto'] : [];
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
      return codexFullAuto ? ['--full-auto', '--json'] : ['--json'];
    case 'gemini':
      return ['--output-format', 'stream-json'];
    case 'opencode':
      return ['--format', 'json'];
    case 'cursor':
      return [];
  }
}
