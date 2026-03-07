import { spawn, type ChildProcess } from 'node:child_process';
import type { BuildOptions, CommandSpec, Harness, HarnessName, GeminiAlias } from './types';
import { buildCommand } from './build';
import { canonicalizeHarness } from './harnesses';

/**
 * Options for runCommand — extends BuildOptions with process-level settings.
 */
export interface RunOptions extends BuildOptions {
  /** Callback for stdout data chunks. If not provided, stdout is inherited. */
  onStdout?: (data: Buffer) => void;
  /** Callback for stderr data chunks. If not provided, stderr is inherited. */
  onStderr?: (data: Buffer) => void;
  /** Spawn detached process group (used by long-running server integrations). */
  detached?: boolean;
}

/**
 * Result from a completed agent run.
 */
export interface RunResult {
  /** Process exit code (null if killed by signal) */
  exitCode: number | null;
  /** The CommandSpec that was executed */
  spec: CommandSpec;
}

export type CodexReasoningLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type TurnMode = 'conversation' | 'single-shot';
export type CompletionReason = 'success' | 'out_of_tokens' | 'error' | 'killed';

type BaseExecuteCommandRequest<THarness extends HarnessName> = {
  harness: THarness;
  mode: TurnMode;
  prompt: string;
  cwd: string;
  model?: string;
  extraArgs?: readonly string[];
  /** Explicit first-turn session ID to create/use when not resuming. */
  sessionId?: string;
  /** Existing provider session ID to resume. */
  resumeSessionId?: string;
  /** True by default: run in maximum non-interactive mode where supported. */
  yolo?: boolean;
  /** Mirror raw provider stdout/stderr to this process stderr for debugging. */
  debugRawEvents?: boolean;
  /** Spawn detached process group. */
  detached?: boolean;
};

type CodexExecuteCommandRequest = BaseExecuteCommandRequest<'codex'> & {
  reasoningEffort?: CodexReasoningLevel;
  /**
   * Codex-only automation mode.
   * When true, executeCommand adds `--full-auto` and suppresses
   * `--dangerously-bypass-approvals-and-sandbox` (the two flags are incompatible).
   */
  fullAuto?: boolean;
};

type NonCodexExecuteCommandRequest<THarness extends Exclude<HarnessName, 'codex'>> =
  BaseExecuteCommandRequest<THarness> & {
    reasoningEffort?: never;
    fullAuto?: never;
  };

export type ExecuteCommandRequest =
  | CodexExecuteCommandRequest
  | NonCodexExecuteCommandRequest<'claude'>
  | NonCodexExecuteCommandRequest<'opencode'>
  | NonCodexExecuteCommandRequest<'gemini'>
  | NonCodexExecuteCommandRequest<GeminiAlias>;

export type UnifiedAgentEvent =
  | { type: 'session.started'; sessionId: string }
  | { type: 'turn.started' }
  | { type: 'text.delta'; text: string }
  | { type: 'tool.use'; name: string; input: Record<string, unknown>; displayText?: string }
  | { type: 'out_of_tokens'; message: string }
  | { type: 'error'; message: string }
  | { type: 'turn.complete'; reason: CompletionReason }
  | { type: 'stderr'; text: string };

export interface ExecuteCommandCompletion {
  /** Final completion reason for the turn (matches the terminal `turn.complete` event). */
  reason: CompletionReason;
  /** Process exit code (null when terminated by signal). */
  exitCode: number | null;
  /** Final resolved provider session/thread id for this turn. */
  sessionId: string;
  /** Built command spec that was executed. */
  spec: CommandSpec;
}

export interface ExecuteCommandHandle {
  child: ChildProcess;
  spec: CommandSpec;
  events: AsyncIterable<UnifiedAgentEvent>;
  /** Resolves to the same final sessionId returned by `completed`. */
  sessionId: Promise<string>;
  /** Resolves exactly once when the turn finishes. */
  completed: Promise<ExecuteCommandCompletion>;
  stop: (signal?: NodeJS.Signals) => void;
}

interface AsyncQueue<T> {
  push: (value: T) => void;
  close: () => void;
  iterator: AsyncIterableIterator<T>;
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  const iterator: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (values.length > 0) {
        return Promise.resolve({ done: false, value: values.shift()! });
      }
      if (closed) {
        return Promise.resolve({ done: true, value: undefined as never });
      }
      return new Promise<IteratorResult<T>>((resolve) => {
        waiters.push(resolve);
      });
    },
  };

  const push = (value: T): void => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    values.push(value);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      waiter({ done: true, value: undefined as never });
    }
  };

  return { push, close, iterator };
}

const OUT_OF_TOKENS_PATTERN =
  /out of tokens|token limit|usage limit|insufficient (?:credits|balance)|exceeded(?: your)?(?: current)? quota|credit balance|rate limit exceeded/i;

function classifyError(message: string): { kind: 'out_of_tokens' | 'error'; message: string } {
  const trimmed = message.trim();
  if (!trimmed) {
    return { kind: 'error', message: 'Unknown error' };
  }
  if (OUT_OF_TOKENS_PATTERN.test(trimmed)) {
    return {
      kind: 'out_of_tokens',
      message: /^out of tokens:/i.test(trimmed) ? trimmed : `Out of tokens: ${trimmed}`,
    };
  }
  return { kind: 'error', message: trimmed };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/-/g, '_').toLowerCase();
}

function looksLikeInteractiveAuthPrompt(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('opening authentication page in your browser')
    || normalized.includes('open authentication page in your browser')
    || normalized.includes('sign in with your browser')
    || normalized.includes('login with your browser')
    || normalized.includes('authenticate in your browser');
}

function summarizeRawStdout(harness: string, text: string): string {
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 240);
  if (looksLikeInteractiveAuthPrompt(text)) {
    return `AUTH_REQUIRED: ${harness} requested interactive authentication. Authenticate that harness outside oompa first. Raw stdout: ${snippet}`;
  }
  return `${harness} emitted non-JSON stdout in conversation mode: ${snippet}`;
}

function mirrorDebugLines(prefix: string, text: string, trailing: string): string {
  const combined = trailing + text;
  const lines = combined.split('\n');
  const nextTrailing = lines.pop() ?? '';
  for (const line of lines) {
    process.stderr.write(`${prefix}${line.replace(/\r$/, '')}\n`);
  }
  return nextTrailing;
}

function flushDebugTrailing(prefix: string, trailing: string): void {
  if (trailing.length > 0) {
    process.stderr.write(`${prefix}${trailing.replace(/\r$/, '')}\n`);
  }
}

function buildModeExtraArgs(
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
      case 'opencode':
        return [];
    }
  }

  // conversation mode
  switch (harness) {
    case 'claude': {
      const args = ['-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'];
      if (yolo) {
        args.push('--permission-mode', 'bypassPermissions', '--tools', 'default', '--add-dir', cwd);
      }
      return args;
    }
    case 'codex':
      return codexFullAuto ? ['--full-auto', '--json'] : ['--json'];
    case 'gemini':
      return ['--output-format', 'stream-json'];
    case 'opencode':
      return ['--format', 'json'];
  }
}

function captureSessionIdFromJson(harness: Harness, json: unknown): string | undefined {
  const obj = asObject(json);
  if (!obj) return undefined;

  if (harness === 'codex' && obj.type === 'thread.started') {
    return asString(obj.thread_id);
  }

  if (harness === 'opencode') {
    const part = asObject(obj.part);
    const candidate =
      obj.sessionID ??
      obj.sessionId ??
      obj.session_id ??
      part?.sessionID ??
      part?.sessionId ??
      part?.session_id;
    return asString(candidate);
  }

  if (harness === 'claude') {
    return asString(obj.session_id) ?? asString(obj.sessionId);
  }

  if (harness === 'gemini') {
    return asString(obj.session_id) ?? asString(obj.sessionId);
  }

  return undefined;
}

/**
 * Stateful Claude stream parser.
 *
 * Claude's streaming protocol splits tool_use across three event types:
 *   1. content_block_start  — tool name + block ID (no input yet)
 *   2. content_block_delta  — input_json_delta chunks (partial JSON fragments)
 *   3. content_block_stop   — signals the block is complete
 *
 * The old stateless parser emitted tool.use at content_block_start with only
 * { _blockId }, so formatToolUse never saw the `command` field and couldn't
 * detect oompa launches. This stateful version accumulates input_json_delta
 * fragments and emits tool.use with the full reconstructed input at
 * content_block_stop.
 */
function createClaudeParser(): (json: unknown) => UnifiedAgentEvent[] {
  // Track the in-flight tool_use block being streamed.
  let pendingTool: { name: string; inputJson: string } | null = null;

  return (json: unknown): UnifiedAgentEvent[] => {
    const obj = asObject(json);
    if (!obj) return [{ type: 'error', message: 'Claude emitted non-object JSON' }];

    const type = asString(obj.type);
    if (type === 'system' && asString(obj.subtype) === 'init') {
      return [{ type: 'turn.started' }];
    }

    if (type === 'stream_event') {
      const event = asObject(obj.event);
      const eventType = asString(event?.type);

      if (eventType === 'content_block_delta') {
        const delta = asObject(event?.delta);
        const deltaType = asString(delta?.type);
        if (deltaType === 'text_delta' && asString(delta?.text)) {
          return [{ type: 'text.delta', text: asString(delta!.text)! }];
        }
        // Accumulate input_json_delta fragments for the pending tool block.
        if (deltaType === 'input_json_delta' && pendingTool) {
          const partial = asString(delta?.partial_json);
          if (partial) pendingTool.inputJson += partial;
        }
        return [];
      }

      if (eventType === 'content_block_start') {
        const contentBlock = asObject(event?.content_block);
        if (asString(contentBlock?.type) === 'tool_use') {
          const name = asString(contentBlock?.name) ?? 'tool';
          // Start accumulating — don't emit tool.use yet (wait for full input).
          pendingTool = { name, inputJson: '' };
        }
        return [];
      }

      if (eventType === 'content_block_stop') {
        if (pendingTool) {
          const { name, inputJson } = pendingTool;
          pendingTool = null;

          let input: Record<string, unknown> = {};
          if (inputJson) {
            try {
              input = JSON.parse(inputJson) as Record<string, unknown>;
            } catch {
              // Malformed JSON — emit with empty input rather than losing the event.
            }
          }

          // AskUserQuestion and Task get special treatment downstream.
          if (name === 'AskUserQuestion' || name === 'Task') {
            return [{ type: 'tool.use', name, input }];
          }

          return [{ type: 'tool.use', name, input, displayText: `${name}\n` }];
        }
        return [];
      }

      return [];
    }

    if (type === 'assistant') {
      const message = asObject(obj.message);
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          const block = asObject(item);
          if (asString(block?.type) === 'tool_use' && asString(block?.name) === 'AskUserQuestion') {
            const input = asObject(block?.input) ?? {};
            return [
              {
                type: 'text.delta',
                text: `\n<!--ask_user_question:${JSON.stringify(input)}-->\n`,
              },
            ];
          }
        }
      }
      return [];
    }

    if (type === 'result') {
      const subtype = asString(obj.subtype);
      if (subtype === 'success') {
        return [{ type: 'turn.complete', reason: 'success' }];
      }
      const message = asString(obj.result) ?? 'Claude returned an error';
      const classified = classifyError(message);
      return [
        classified.kind === 'out_of_tokens'
          ? { type: 'out_of_tokens', message: classified.message }
          : { type: 'error', message: classified.message },
        { type: 'turn.complete', reason: classified.kind === 'out_of_tokens' ? 'out_of_tokens' : 'error' },
      ];
    }

    return [];
  };
}

// Stateless wrapper for non-streaming contexts (e.g. JSONL replay).
function parseClaude(json: unknown): UnifiedAgentEvent[] {
  return createClaudeParser()(json);
}

// Exported for testing.
export { createClaudeParser };

function parseCodex(json: unknown): UnifiedAgentEvent[] {
  const obj = asObject(json);
  if (!obj) return [{ type: 'error', message: 'Codex emitted non-object JSON' }];

  const type = asString(obj.type);
  if (!type) return [];

  switch (type) {
    case 'thread.started':
      return [];
    case 'turn.started':
      return [{ type: 'turn.started' }];
    case 'turn.completed':
      return [{ type: 'turn.complete', reason: 'success' }];
    case 'turn.failed': {
      const rawErr = obj.error;
      const message =
        asString(rawErr) ??
        asString(asObject(rawErr)?.message) ??
        JSON.stringify(rawErr ?? 'Unknown error');
      const classified = classifyError(message);
      return [
        classified.kind === 'out_of_tokens'
          ? { type: 'out_of_tokens', message: classified.message }
          : { type: 'error', message: classified.message },
        { type: 'turn.complete', reason: classified.kind === 'out_of_tokens' ? 'out_of_tokens' : 'error' },
      ];
    }
    case 'error': {
      const classified = classifyError(asString(obj.message) ?? JSON.stringify(obj));
      return [
        classified.kind === 'out_of_tokens'
          ? { type: 'out_of_tokens', message: classified.message }
          : { type: 'error', message: classified.message },
      ];
    }
    case 'item.started': {
      const item = asObject(obj.item);
      if (asString(item?.type) === 'command_execution' && asString(item?.command)) {
        const command = asString(item!.command)!;
        return [{ type: 'tool.use', name: 'shell', input: { command }, displayText: `${command}\n` }];
      }
      return [];
    }
    case 'item.completed': {
      const item = asObject(obj.item);
      const itemType = asString(item?.type);
      if (!itemType) return [];

      if (itemType === 'agent_message' && asString(item?.text)) {
        return [{ type: 'text.delta', text: asString(item!.text)! }];
      }

      if (itemType === 'command_execution') {
        const command = asString(item?.command) ?? '';
        const exitCode = typeof item?.exit_code === 'number' ? item.exit_code : undefined;
        return [
          {
            type: 'tool.use',
            name: 'shell',
            input: {
              command,
              ...(exitCode === undefined ? {} : { exit_code: exitCode }),
            },
          },
        ];
      }

      if (itemType === 'file_change') {
        const changes = Array.isArray(item?.changes) ? item!.changes : [];
        return [{ type: 'tool.use', name: 'file_change', input: { changes } }];
      }

      if (itemType === 'mcp_tool_call') {
        const name = asString(item?.name) ?? 'mcp_tool';
        return [{ type: 'tool.use', name, input: {} }];
      }

      if (itemType === 'web_search') {
        return [{ type: 'tool.use', name: 'web_search', input: {} }];
      }

      return [];
    }
    default:
      return [];
  }
}

function extractOpenCodeAssistantText(obj: Record<string, unknown>): string | undefined {
  const direct = asString(obj.text);
  if (direct) return direct;

  const part = asObject(obj.part);
  const partText = asString(part?.text);
  if (partText) return partText;

  const delta = asObject(part?.delta);
  const deltaText = asString(delta?.text);
  if (deltaText) return deltaText;

  const message = asObject(obj.message);
  const messageText = asString(message?.text) ?? asString(message?.content);
  if (messageText) return messageText;

  const content = message?.content;
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const entry of content) {
      const item = asObject(entry);
      const text = asString(item?.text);
      if (text) chunks.push(text);
    }
    if (chunks.length > 0) return chunks.join('');
  }

  return undefined;
}

function parseOpenCode(json: unknown): UnifiedAgentEvent[] {
  const obj = asObject(json);
  if (!obj) return [{ type: 'error', message: 'OpenCode emitted non-object JSON' }];

  const topType = normalizeType(asString(obj.type));
  const partType = normalizeType(asString(asObject(obj.part)?.type));
  const eventType = topType ?? partType;

  switch (eventType) {
    case 'step_start':
      return [{ type: 'turn.started' }];
    case 'text': {
      const text = extractOpenCodeAssistantText(obj);
      return text ? [{ type: 'text.delta', text }] : [];
    }
    case 'tool_use':
    case 'tool': {
      const part = asObject(obj.part) ?? {};
      const state = asObject(part.state);
      const input = asObject(state?.input) ?? {};
      const name = asString(part.tool) ?? asString(obj.tool) ?? 'tool';
      return [{ type: 'tool.use', name, input }];
    }
    case 'step_finish': {
      const part = asObject(obj.part);
      const reasonRaw = asString(part?.reason) ?? asString(obj.reason);
      const reason = normalizeType(reasonRaw);
      if (reason === 'tool_calls') return [];
      if (
        reason === 'failed' ||
        reason === 'error' ||
        reason === 'abort' ||
        reason === 'aborted' ||
        reason === 'cancel' ||
        reason === 'cancelled' ||
        reason === 'canceled'
      ) {
        const classified = classifyError(`OpenCode step failed (${reasonRaw ?? 'unknown'})`);
        return [
          classified.kind === 'out_of_tokens'
            ? { type: 'out_of_tokens', message: classified.message }
            : { type: 'error', message: classified.message },
          { type: 'turn.complete', reason: classified.kind === 'out_of_tokens' ? 'out_of_tokens' : 'error' },
        ];
      }
      return [{ type: 'turn.complete', reason: 'success' }];
    }
    case 'done':
    case 'complete':
    case 'message_complete':
    case 'response_complete':
      return [{ type: 'turn.complete', reason: 'success' }];
    case 'error': {
      const message =
        asString(obj.message) ??
        asString(asObject(obj.error)?.message) ??
        'OpenCode error';
      const classified = classifyError(message);
      return [
        classified.kind === 'out_of_tokens'
          ? { type: 'out_of_tokens', message: classified.message }
          : { type: 'error', message: classified.message },
      ];
    }
    default: {
      const fallback = extractOpenCodeAssistantText(obj);
      return fallback ? [{ type: 'text.delta', text: fallback }] : [];
    }
  }
}

function parseGemini(json: unknown): UnifiedAgentEvent[] {
  const obj = asObject(json);
  if (!obj) return [{ type: 'error', message: 'Gemini emitted non-object JSON' }];

  const type = asString(obj.type);
  if (!type) {
    return [{ type: 'error', message: `Gemini JSON missing required "type": ${JSON.stringify(obj)}` }];
  }
  if (type === 'init') return [{ type: 'turn.started' }];

  if (type === 'message') {
    if (asString(obj.role) === 'assistant' && asString(obj.content)) {
      return [{ type: 'text.delta', text: asString(obj.content)! }];
    }
    return [];
  }

  if (type === 'tool_use') {
    const name = asString(obj.tool_name) || 'tool';
    const input = asObject(obj.parameters) || {};
    return [{ type: 'tool.use', name, input }];
  }

  if (type === 'tool_result') {
    return [];
  }

  if (type === 'result') {
    if (asString(obj.status) === 'success') {
      return [{ type: 'turn.complete', reason: 'success' }];
    }
    const message =
      asString(obj.error) ??
      asString(obj.message) ??
      `Gemini result failed: ${String(obj.status ?? 'unknown')}`;
    const classified = classifyError(message);
    return [
      classified.kind === 'out_of_tokens'
        ? { type: 'out_of_tokens', message: classified.message }
        : { type: 'error', message: classified.message },
      { type: 'turn.complete', reason: classified.kind === 'out_of_tokens' ? 'out_of_tokens' : 'error' },
    ];
  }

  return [{ type: 'error', message: `Gemini emitted unrecognized event type "${type}": ${JSON.stringify(obj)}` }];
}

function parseJsonEvent(harness: Harness, json: unknown): UnifiedAgentEvent[] {
  switch (harness) {
    case 'claude':
      return parseClaude(json);
    case 'codex':
      return parseCodex(json);
    case 'opencode':
      return parseOpenCode(json);
    case 'gemini':
      return parseGemini(json);
  }
}

/**
 * Create a stateful parser for a harness. Claude needs cross-event state to
 * accumulate tool input_json_delta; other harnesses are stateless wrappers.
 */
function createParser(harness: Harness): (json: unknown) => UnifiedAgentEvent[] {
  if (harness === 'claude') return createClaudeParser();
  return (json: unknown) => parseJsonEvent(harness, json);
}

/**
 * Spawn an agent CLI process with the correct flags and IO handling.
 *
 * For streaming output, pass onStdout/onStderr callbacks.
 * Without callbacks, stdout/stderr are inherited (pass through to parent).
 */
export function runCommand(harness: string, options: RunOptions = {}): {
  child: ChildProcess;
  spec: CommandSpec;
  done: Promise<RunResult>;
} {
  const spec = buildCommand(harness, options);
  const [bin, ...args] = spec.argv;

  const useCallbacks = options.onStdout || options.onStderr;

  const child = spawn(bin, args, {
    cwd: options.cwd,
    detached: options.detached === true,
    stdio: [
      'pipe', // stdin: we control it
      useCallbacks ? 'pipe' : 'inherit',
      useCallbacks ? 'pipe' : 'inherit',
    ],
  });

  // Deliver prompt via stdin based on harness config
  if (child.stdin) {
    if (spec.stdin === 'prompt' && spec.prompt) {
      child.stdin.write(spec.prompt);
    }
    if (spec.stdin !== 'pipe') {
      child.stdin.end();
    }
  }

  if (options.onStdout && child.stdout) {
    child.stdout.on('data', options.onStdout);
  }
  if (options.onStderr && child.stderr) {
    child.stderr.on('data', options.onStderr);
  }

  const done = new Promise<RunResult>((resolve, reject) => {
    child.on('close', (code) => resolve({ exitCode: code, spec }));
    child.on('error', reject);
  });

  return { child, spec, done };
}

/**
 * Unified semantic execution API.
 *
 * Caller passes one typed request. Library handles:
 * - harness-specific CLI flags / resume mechanics
 * - JSONL buffering + protocol normalization
 * - unified event stream + completion + resolved session id
 */
export function executeCommand(request: ExecuteCommandRequest): ExecuteCommandHandle {
  const queue = createAsyncQueue<UnifiedAgentEvent>();
  const canonicalHarness = canonicalizeHarness(request.harness);
  const yolo = request.yolo !== false;
  const codexFullAuto = canonicalHarness === 'codex' && request.fullAuto === true;
  const bypassPermissions = yolo && !(canonicalHarness === 'codex' && codexFullAuto);
  const requestedSessionId = request.resumeSessionId ?? request.sessionId;
  const initialSessionId = requestedSessionId ?? null;
  let resolvedSessionId = requestedSessionId ?? '';
  let completionReason: CompletionReason = 'success';
  let completeEventSeen = false;
  let turnStartedSeen = false;
  let stopRequested = false;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let debugStderrTrailing = '';
  const parse = createParser(canonicalHarness);

  let resolveSessionId!: (value: string) => void;
  const sessionId = new Promise<string>((resolve) => {
    resolveSessionId = resolve;
  });

  const buildOptions: BuildOptions = {
    model: request.model,
    prompt: request.prompt,
    sessionId: initialSessionId ?? undefined,
    resume: !!request.resumeSessionId,
    cwd: request.cwd,
    bypassPermissions,
    extraArgs: [
      ...buildModeExtraArgs(canonicalHarness, request.mode, yolo, request.cwd, codexFullAuto),
      ...(request.extraArgs ?? []),
    ],
  };
  if (canonicalHarness === 'codex' && request.reasoningEffort) {
    buildOptions.reasoning = request.reasoningEffort;
  }

  const emit = (event: UnifiedAgentEvent): void => {
    if (event.type === 'turn.started') {
      if (turnStartedSeen) return;
      turnStartedSeen = true;
    } else if (event.type === 'turn.complete') {
      if (completeEventSeen) return;
      completeEventSeen = true;
      completionReason = event.reason;
    } else if (event.type === 'out_of_tokens') {
      completionReason = 'out_of_tokens';
    } else if (event.type === 'error' && completionReason === 'success') {
      completionReason = 'error';
    }
    queue.push(event);
  };

  const maybeUpdateSession = (json: unknown): void => {
    const captured = captureSessionIdFromJson(canonicalHarness, json);
    if (captured && captured !== resolvedSessionId) {
      resolvedSessionId = captured;
      emit({ type: 'session.started', sessionId: captured });
    }
  };

  const onStdout = (chunk: Buffer): void => {
    const text = chunk.toString();

    if (request.mode === 'single-shot') {
      if (request.debugRawEvents && text.length > 0) {
        process.stderr.write(`[agent-cli raw ${request.harness} stdout] ${text}`);
        if (!text.endsWith('\n')) process.stderr.write('\n');
      }
      if (text.length > 0) emit({ type: 'text.delta', text });
      return;
    }

    stdoutBuffer += text;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';

    if (request.debugRawEvents) {
      for (const line of lines) {
        process.stderr.write(`[agent-cli raw ${request.harness} stdout] ${line.replace(/\r$/, '')}\n`);
      }
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let json: unknown;
      try {
        json = JSON.parse(trimmed) as unknown;
      } catch (err) {
        emit({
          type: 'error',
          message: summarizeRawStdout(request.harness, trimmed),
        });
        continue;
      }

      maybeUpdateSession(json);
      for (const event of parse(json)) {
        emit(event);
      }
    }
  };

  const onStderr = (chunk: Buffer): void => {
    const text = chunk.toString();
    if (request.debugRawEvents) {
      debugStderrTrailing = mirrorDebugLines(`[agent-cli raw ${request.harness} stderr] `, text, debugStderrTrailing);
    }
    emit({ type: 'stderr', text });
    stderrBuffer += text;
  };

  const { child, spec, done } = runCommand(request.harness, {
    ...buildOptions,
    detached: request.detached === true,
    onStdout,
    onStderr,
  });

  if (request.detached === true) {
    child.unref();
  }

  if (resolvedSessionId) {
    emit({ type: 'session.started', sessionId: resolvedSessionId });
  }
  emit({ type: 'turn.started' });

  const completed = done
    .then(({ exitCode, spec: doneSpec }) => {
      if (request.mode === 'conversation') {
        const trailing = stdoutBuffer.trim();
        if (trailing) {
          if (request.debugRawEvents) {
            process.stderr.write(`[agent-cli raw ${request.harness} stdout] ${trailing.replace(/\r$/, '')}\n`);
          }
          try {
            const json = JSON.parse(trailing) as unknown;
            maybeUpdateSession(json);
            for (const event of parse(json)) {
              emit(event);
            }
          } catch {
            emit({
              type: 'error',
              message: summarizeRawStdout(request.harness, trailing),
            });
          }
        }
      }

      if (request.debugRawEvents) {
        flushDebugTrailing(`[agent-cli raw ${request.harness} stderr] `, debugStderrTrailing);
      }

      let finalReason = completionReason;
      if (!completeEventSeen) {
        if (stopRequested || exitCode === null) {
          finalReason = 'killed';
        } else if (completionReason !== 'success') {
          finalReason = completionReason;
        } else if (request.mode === 'conversation') {
          // Conversation mode must end on an explicit terminal event from the harness.
          // Treat a silent process exit as an error to avoid false "success" turns.
          finalReason = 'error';
          
          let details = '';
          if (exitCode !== 0 && exitCode !== null) {
            const stderrStr = stderrBuffer.trim();
            if (stderrStr) {
               const lines = stderrStr.split('\n');
               details = `: ${lines[lines.length - 1]}`;
            }
          }
          
          emit({
            type: 'error',
            message: `${request.harness} exited without a terminal turn.complete event${details}`,
          });
        } else {
          finalReason = exitCode === 0 ? 'success' : 'error';
        }
        emit({ type: 'turn.complete', reason: finalReason });
      }

      queue.close();
      resolveSessionId(resolvedSessionId);
      return {
        reason: finalReason,
        exitCode,
        sessionId: resolvedSessionId,
        spec: doneSpec,
      };
    })
    .catch((err) => {
      emit({
        type: 'error',
        message: `Process failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      emit({ type: 'turn.complete', reason: stopRequested ? 'killed' : 'error' });
      queue.close();
      resolveSessionId(resolvedSessionId);
      throw err;
    });

  return {
    child,
    spec,
    events: queue.iterator,
    sessionId,
    completed,
    stop: (signal?: NodeJS.Signals) => {
      stopRequested = true;
      if (child.exitCode === null && !child.killed) {
        child.kill(signal);
      }
    },
  };
}

// Back-compat alias while callers migrate.
export const executeTurn = executeCommand;

// Back-compat type aliases while callers migrate.
export type ExecuteTurnRequest = ExecuteCommandRequest;
export type ExecuteTurnEvent = UnifiedAgentEvent;
export type ExecuteTurnCompletion = ExecuteCommandCompletion;
export type ExecuteTurnHandle = ExecuteCommandHandle;
