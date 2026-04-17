import type { CompletionReason, UnifiedAgentEvent } from './runtime-types.ts';

const OUT_OF_TOKENS_PATTERN =
  /out of tokens|token limit|usage limit|insufficient (?:credits|balance)|exceeded(?: your)?(?: current)? quota|credit balance|rate limit exceeded/i;
const ANSI_RE = /[\u001b\u009b][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function classifyError(message: string): { kind: 'out_of_tokens' | 'error'; message: string } {
  const trimmed = message.trim();
  if (!trimmed) return { kind: 'error', message: 'Unknown error' };
  if (!OUT_OF_TOKENS_PATTERN.test(trimmed)) return { kind: 'error', message: trimmed };
  return {
    kind: 'out_of_tokens',
    message: /^out of tokens:/i.test(trimmed) ? trimmed : `Out of tokens: ${trimmed}`,
  };
}

export function failureEvents(message: string, complete = true): UnifiedAgentEvent[] {
  const classified = classifyError(message);
  const reason: CompletionReason =
    classified.kind === 'out_of_tokens' ? 'out_of_tokens' : 'error';
  const first: UnifiedAgentEvent =
    classified.kind === 'out_of_tokens'
      ? { type: 'out_of_tokens', message: classified.message }
      : { type: 'error', message: classified.message };
  return complete ? [first, { type: 'turn.complete', reason }] : [first];
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function looksLikeInteractiveAuthPrompt(text: string): boolean {
  const normalized = stripAnsi(text).toLowerCase();
  return (
    normalized.includes('opening authentication page in your browser') ||
    normalized.includes('open authentication page in your browser') ||
    normalized.includes('sign in with your browser') ||
    normalized.includes('login with your browser') ||
    normalized.includes('authenticate in your browser') ||
    normalized.includes('press any key to sign in')
  );
}

export function summarizeRawStdout(harness: string, text: string): string {
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 240);
  if (looksLikeInteractiveAuthPrompt(text)) {
    return `AUTH_REQUIRED: ${harness} requested interactive authentication. Authenticate that harness outside oompa first. Raw stdout: ${snippet}`;
  }
  return `${harness} emitted non-JSON stdout in conversation mode: ${snippet}`;
}

export function mirrorDebugLines(prefix: string, text: string, trailing: string): string {
  const lines = (trailing + text).split('\n');
  const nextTrailing = lines.pop() ?? '';
  for (const line of lines) {
    process.stderr.write(`${prefix}${line.replace(/\r$/, '')}\n`);
  }
  return nextTrailing;
}

export function flushDebugTrailing(prefix: string, trailing: string): void {
  if (trailing.length > 0) {
    process.stderr.write(`${prefix}${trailing.replace(/\r$/, '')}\n`);
  }
}
