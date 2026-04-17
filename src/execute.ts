import type { BuildOptions } from './types.ts';
import { canonicalizeHarness } from './harnesses/index.ts';
import { createAsyncQueue } from './async-queue.ts';
import {
  flushDebugTrailing,
  looksLikeInteractiveAuthPrompt,
  mirrorDebugLines,
  stripAnsi,
  summarizeRawStdout,
} from './diagnostics.ts';
import { createHeartbeat } from './heartbeat.ts';
import { asString } from './json-utils.ts';
import { buildModeExtraArgs } from './mode-args.ts';
import { createParser, type HarnessParser } from './parsers/index.ts';
import { runCommand } from './process-runner.ts';
import { prepareSession, captureSessionIdFromJson } from './session.ts';
import type {
  CompletionReason,
  ExecuteCommandCompletion,
  ExecuteCommandHandle,
  ExecuteCommandRequest,
  UnifiedAgentEvent,
} from './runtime-types.ts';

type Emit = (event: UnifiedAgentEvent) => void;

function createStdoutProcessor(
  request: ExecuteCommandRequest,
  parse: HarnessParser,
  emit: Emit,
  updateSession: (json: unknown) => void,
  markStdout: () => void
) {
  let stdoutBuffer = '';
  let bufferedRawStdoutLines: string[] = [];
  let sawParsedStdoutJson = false;
  let authErrorEmitted = false;
  const rawPrefix = `[agent-cli raw ${request.harness} stdout] `;

  const emitRawError = (text: string): void => {
    emit({ type: 'error', message: summarizeRawStdout(request.harness, text) });
  };

  const bufferRawLine = (line: string): void => {
    const nextBuffered = [...bufferedRawStdoutLines, line].slice(-20);
    const combined = nextBuffered.join('\n');
    if (looksLikeInteractiveAuthPrompt(combined)) {
      if (!authErrorEmitted) emitRawError(combined);
      authErrorEmitted = true;
      bufferedRawStdoutLines = [];
      return;
    }
    if (!sawParsedStdoutJson) {
      bufferedRawStdoutLines = nextBuffered;
      return;
    }
    emitRawError(line);
  };

  const processJsonLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const cleaned = stripAnsi(trimmed).trim();
    if (!cleaned) return;
    let json: unknown;
    try {
      json = JSON.parse(cleaned) as unknown;
    } catch {
      bufferRawLine(trimmed);
      return;
    }
    sawParsedStdoutJson = true;
    bufferedRawStdoutLines = [];
    updateSession(json);
    for (const event of parse(json)) emit(event);
  };

  return {
    onChunk(chunk: Buffer): void {
      markStdout();
      const text = chunk.toString();
      if (request.mode === 'single-shot') {
        if (request.debugRawEvents && text.length > 0) {
          process.stderr.write(`${rawPrefix}${text}`);
          if (!text.endsWith('\n')) process.stderr.write('\n');
        }
        if (text.length > 0) emit({ type: 'text.delta', text });
        return;
      }

      stdoutBuffer += text;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      if (request.debugRawEvents) {
        for (const line of lines) process.stderr.write(`${rawPrefix}${line.replace(/\r$/, '')}\n`);
      }
      for (const line of lines) processJsonLine(line);
    },
    flush(): void {
      if (request.mode !== 'conversation') return;
      const trailing = stdoutBuffer.trim();
      if (trailing) {
        if (request.debugRawEvents) process.stderr.write(`${rawPrefix}${trailing.replace(/\r$/, '')}\n`);
        processJsonLine(trailing);
      }
      if (bufferedRawStdoutLines.length > 0 && !authErrorEmitted) {
        emitRawError(bufferedRawStdoutLines.join('\n'));
        bufferedRawStdoutLines = [];
      }
    },
  };
}

function createStderrProcessor(request: ExecuteCommandRequest, emit: Emit) {
  let stderrBuffer = '';
  let debugTrailing = '';
  const rawPrefix = `[agent-cli raw ${request.harness} stderr] `;

  return {
    onChunk(chunk: Buffer): void {
      const text = chunk.toString();
      if (request.debugRawEvents) {
        debugTrailing = mirrorDebugLines(rawPrefix, text, debugTrailing);
      }
      stderrBuffer += text;
      emit({ type: 'stderr', text });
    },
    flush(): void {
      if (request.debugRawEvents) flushDebugTrailing(rawPrefix, debugTrailing);
    },
    buffer(): string {
      return stderrBuffer;
    },
  };
}

function silentExitError(
  request: ExecuteCommandRequest,
  exitCode: number | null,
  sawMeaningfulContent: boolean,
  stderrBuffer: string
): string {
  const parts: string[] = [];
  if (exitCode !== null && exitCode !== 0) parts.push(`exit=${exitCode}`);
  if (!sawMeaningfulContent) parts.push('no content ever received');
  const stderr = stderrBuffer.trim();
  if (stderr) parts.push(stderr.split('\n').pop()!);
  const details = parts.length > 0 ? ` (${parts.join('; ')})` : '';
  return `${request.harness} exited without a terminal turn.complete event${details}`;
}

export function executeCommand(request: ExecuteCommandRequest): ExecuteCommandHandle {
  const queue = createAsyncQueue<UnifiedAgentEvent>();
  const canonicalHarness = canonicalizeHarness(request.harness);
  const yolo = request.yolo !== false;
  const codexFullAuto =
    canonicalHarness === 'codex' && 'fullAuto' in request && request.fullAuto === true;
  const bypassPermissions = yolo && !(canonicalHarness === 'codex' && codexFullAuto);
  const session = prepareSession(request);
  const parse = createParser(canonicalHarness);

  let resolvedSessionId = session.resolvedSessionId;
  let completionReason: CompletionReason = 'success';
  let completeEventSeen = false;
  let turnStartedSeen = false;
  let stopRequested = false;

  let resolveSessionId!: (value: string) => void;
  const sessionId = new Promise<string>((resolve) => {
    resolveSessionId = resolve;
  });

  const heartbeat = createHeartbeat(request.mode === 'conversation', (event) => emit(event));

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
    if (event.type === 'text.delta' || event.type === 'tool.use') {
      heartbeat.markMeaningful();
    }
    queue.push(event);
  };

  const updateSession = (json: unknown): void => {
    const captured = captureSessionIdFromJson(canonicalHarness, json);
    if (captured && captured !== resolvedSessionId) {
      resolvedSessionId = captured;
      emit({ type: 'session.started', sessionId: captured });
    }
  };

  const reasoningEffort = 'reasoningEffort' in request ? request.reasoningEffort : undefined;
  const buildOptions: BuildOptions = {
    model: request.model,
    prompt: request.prompt,
    sessionId: session.buildSessionId,
    resume: session.resume,
    fork: session.fork,
    cwd: request.cwd,
    bypassPermissions,
    extraArgs: [
      ...buildModeExtraArgs(canonicalHarness, request.mode, yolo, request.cwd, codexFullAuto),
      ...(request.extraArgs ?? []),
    ],
    ...(reasoningEffort && (canonicalHarness === 'codex' || canonicalHarness === 'claude')
      ? { reasoning: reasoningEffort }
      : {}),
  };

  const stdout = createStdoutProcessor(request, parse, emit, updateSession, () => heartbeat.markStdout());
  const stderr = createStderrProcessor(request, emit);
  const { child, spec, done } = runCommand(request.harness, {
    ...buildOptions,
    detached: request.detached === true,
    onStdout: (chunk) => stdout.onChunk(chunk),
    onStderr: (chunk) => stderr.onChunk(chunk),
  });

  heartbeat.start();
  if (request.detached === true) child.unref();
  if (resolvedSessionId) emit({ type: 'session.started', sessionId: resolvedSessionId });
  emit({ type: 'turn.started' });

  const completed = done
    .then(({ exitCode, spec: doneSpec }) => {
      heartbeat.stop();
      stdout.flush();
      stderr.flush();

      let finalReason = completionReason;
      if (!completeEventSeen) {
        if (stopRequested || exitCode === null) {
          finalReason = 'killed';
        } else if (completionReason !== 'success') {
          finalReason = completionReason;
        } else if (request.mode === 'conversation') {
          finalReason = 'error';
          emit({
            type: 'error',
            message: silentExitError(
              request,
              exitCode,
              heartbeat.sawMeaningfulContent(),
              stderr.buffer()
            ),
          });
        } else {
          finalReason = exitCode === 0 ? 'success' : 'error';
        }
        emit({ type: 'turn.complete', reason: finalReason });
      }

      queue.close();
      resolveSessionId(resolvedSessionId);
      return { reason: finalReason, exitCode, sessionId: resolvedSessionId, spec: doneSpec };
    })
    .catch((err) => {
      heartbeat.stop();
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
      heartbeat.stop();
      if (child.exitCode === null && !child.killed) {
        if (request.detached && child.pid != null) {
          try {
            process.kill(-child.pid, signal ?? 'SIGTERM');
          } catch {}
        } else {
          child.kill(signal);
        }
      }
    },
  };
}
