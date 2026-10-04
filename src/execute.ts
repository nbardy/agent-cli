import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAsyncQueue } from './async-queue.ts';
import {
  classifyError,
  flushDebugTrailing,
  isTerminalOutOfTokens,
  looksLikeInteractiveAuthPrompt,
  mirrorDebugLines,
  stripAnsi,
  summarizeRawStdout,
} from './diagnostics.ts';
import { canonicalizeHarness, getHarness } from './harnesses/index.ts';
import { createHeartbeat } from './heartbeat.ts';
import { probeMcpServerStartup, requiresStartupProbe } from './mcp-startup.ts';
import { buildModeExtraArgs } from './mode-args.ts';
import { createCodexNativeProgressProbe } from './native-progress.ts';
import { type HarnessParser, createParser } from './parsers/index.ts';
import { buildCommand } from './build.ts';
import {
  type ExecutionRecord,
  followJournal,
  readExecutionRecord,
  readPid,
  signalOwnGroup,
  spawnJournaled,
  writeExecutionRecord,
} from './journal.ts';
import { commandSpawnEnv } from './process-runner.ts';
import { resolveBinary } from './resolve.ts';
import type {
  CompletionReason,
  ExecuteCommandHandle,
  ExecuteCommandRequest,
  ExecutionHandle,
  UnifiedAgentEvent,
} from './runtime-types.ts';
import { captureSessionIdFromJson, prepareSession } from './session.ts';
import type { BuildOptions, McpServerSpec } from './types.ts';

type Emit = (event: UnifiedAgentEvent) => void;

function createStdoutProcessor(
  request: ExecutionRecord,
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
        if (request.debugRawEvents)
          process.stderr.write(`${rawPrefix}${trailing.replace(/\r$/, '')}\n`);
        processJsonLine(trailing);
      }
      if (bufferedRawStdoutLines.length > 0 && !authErrorEmitted) {
        emitRawError(bufferedRawStdoutLines.join('\n'));
        bufferedRawStdoutLines = [];
      }
    },
  };
}

// A CLI-declared fatal line (`ERROR: ...`, codex's plain-text account errors).
// Only these are classified live: codex also logs transient retries to stderr
// (e.g. "stream error: rate limit exceeded; retrying 1/5"), and stopping the
// child on one of those would abort a turn that was about to recover.
const FATAL_STDERR_LINE = /^error:/i;

function createStderrProcessor(request: ExecutionRecord, emit: Emit) {
  let stderrBuffer = '';
  let debugTrailing = '';
  let lineTrailing = '';
  let outOfTokensEmitted = false;
  const rawPrefix = `[agent-cli raw ${request.harness} stderr] `;

  return {
    onChunk(chunk: Buffer): void {
      const text = chunk.toString();
      if (request.debugRawEvents) {
        debugTrailing = mirrorDebugLines(rawPrefix, text, debugTrailing);
      }
      stderrBuffer += text;
      emit({ type: 'stderr', text });
      const lines = (lineTrailing + text).split('\n');
      lineTrailing = lines.pop() ?? '';
      for (const raw of lines) {
        const line = stripAnsi(raw).trim();
        if (outOfTokensEmitted || !FATAL_STDERR_LINE.test(line)) continue;
        const classified = classifyError(line);
        if (classified.kind !== 'out_of_tokens') continue;
        outOfTokensEmitted = true;
        // emit() stops the child on out_of_tokens (see executeCommand).
        emit({ type: 'out_of_tokens', message: classified.message });
      }
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
  request: ExecutionRecord,
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

/** Spawn one CLI turn as a journaled execution (journal.ts) and follow it like an adopter. */
export function executeCommand(request: ExecuteCommandRequest): ExecuteCommandHandle {
  const canonicalHarness = canonicalizeHarness(request.harness);
  const yolo = request.yolo !== false;
  const codexFullAuto =
    canonicalHarness === 'codex' && 'fullAuto' in request && request.fullAuto === true;
  const codexWebSearch =
    canonicalHarness === 'codex' && 'webSearch' in request && request.webSearch === true;
  const bypassPermissions = yolo && !(canonicalHarness === 'codex' && codexFullAuto);
  const session = prepareSession(request);

  const reasoningEffort = 'reasoningEffort' in request ? request.reasoningEffort : undefined;
  const buildOptions: BuildOptions = {
    model: request.model,
    prompt: request.prompt,
    sessionId: session.buildSessionId,
    resume: session.resume,
    fork: session.fork,
    cwd: request.cwd,
    bypassPermissions,
    mcpServers: request.mcpServers,
    extraArgs: [
      ...buildModeExtraArgs(canonicalHarness, request.mode, yolo, request.cwd, codexFullAuto, codexWebSearch),
      ...(request.extraArgs ?? []),
    ],
    ...(reasoningEffort && (canonicalHarness === 'codex' || canonicalHarness === 'claude' || canonicalHarness === 'muse')
      ? { reasoning: reasoningEffort }
      : {}),
  };
  const spec = buildCommand(request.harness, buildOptions);
  if (spec.stdin === 'pipe') {
    throw new Error(`Harness "${request.harness}" keeps stdin open; a journaled execution cannot`);
  }

  // A caller that names no journal gets a private one, removed once the turn ends.
  const ownsJournal = request.journalDir === undefined;
  const dir = request.journalDir ?? mkdtempSync(path.join(tmpdir(), 'agent-cli-exec-'));
  const { harness, mode, debugRawEvents = false } = request;
  const [sessionId, ownedPaths, startedAt] = [session.resolvedSessionId, spec.ownedPaths, new Date().toISOString()];
  const record: ExecutionRecord = { version: 1, harness, mode, debugRawEvents, sessionId, ownedPaths, startedAt };
  writeExecutionRecord(dir, record);
  const [bin, ...args] = spec.argv;
  // Cursor builds `agent`, older installs only have `cursor-agent`; an unresolvable binary is
  // left to the wrapper's shell, which reports "not found" and exits 127.
  let resolved = bin;
  try {
    resolved = resolveBinary(bin);
  } catch {}
  let pid: number;
  try {
    pid = spawnJournaled(dir, resolved, args, {
      cwd: request.cwd,
      env: commandSpawnEnv(spec),
      stdin: spec.stdin === 'prompt' && spec.prompt ? spec.prompt : '',
    });
  } catch (error) {
    removeOwnedPaths(record);
    if (ownsJournal) rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  // Runner-enforced required MCP where the CLI would drop a failed server
  // silently (cursor stdio; every harness for HTTP — see requiresStartupProbe).
  const harnessConfig = getHarness(request.harness);
  const probe = Object.entries(request.mcpServers ?? {}).filter(
    ([, server]) => server.required && requiresStartupProbe(harnessConfig, server)
  );
  return { ...followExecution(dir, record, pid, { ownsJournal, probe }), spec };
}

/** Follow an execution another process started from byte 0: what its spawner saw, then on. */
export function attachExecution(dir: string): ExecutionHandle {
  const record = readExecutionRecord(dir);
  const pid = readPid(dir);
  if (pid === null) throw new Error(`Execution journal ${dir} has no process`);
  // The startup probe ran (or died) with the spawner; it is not repeated.
  return followExecution(dir, record, pid, { ownsJournal: false, probe: [] });
}

function removeOwnedPaths(record: ExecutionRecord): void {
  // Temp config for this process only (muse's may hold a per-turn bearer token).
  for (const owned of record.ownedPaths) rmSync(owned, { recursive: true, force: true });
}

function followExecution(
  dir: string,
  request: ExecutionRecord,
  pid: number,
  options: { ownsJournal: boolean; probe: [string, McpServerSpec][] }
): ExecutionHandle {
  const queue = createAsyncQueue<UnifiedAgentEvent>();
  const canonicalHarness = canonicalizeHarness(request.harness);
  const parse = createParser(canonicalHarness);

  let resolvedSessionId = request.sessionId;
  let completionReason: CompletionReason = 'success';
  let completeEventSeen = false;
  let turnStartedSeen = false;
  let stopRequested = false;
  let nativeProgressProbe =
    canonicalHarness === 'codex' && resolvedSessionId
      ? createCodexNativeProgressProbe(resolvedSessionId)
      : null;

  let resolveSessionId!: (value: string) => void;
  const sessionId = new Promise<string>((resolve) => {
    resolveSessionId = resolve;
  });

  const heartbeat = createHeartbeat(request.mode === 'conversation', (event) => emit(event), {
    nativeProgress: () => nativeProgressProbe?.poll() ?? null,
  });

  const killGroup = (signal?: NodeJS.Signals) => signalOwnGroup(pid, dir, signal ?? 'SIGTERM');

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
      // Exhausted credits are terminal: codex prints its usage-limit line and
      // then idles ~4.5 s before exiting on its own. Stop it now. This is NOT a
      // user stop (stopRequested stays false), so the reason stays out_of_tokens.
      if (isTerminalOutOfTokens(event.message)) killGroup();
    } else if (event.type === 'error' && completionReason === 'success') {
      completionReason = 'error';
    }
    if (event.type === 'text.delta' || event.type === 'tool.use' || event.type === 'subagent.state') {
      heartbeat.markMeaningful();
    }
    if (!(event.type === 'progress' && event.source === 'agent-cli.heartbeat')) {
      heartbeat.markUnifiedEvent();
    }
    queue.push(event);
  };

  const updateSession = (json: unknown): void => {
    const captured = captureSessionIdFromJson(canonicalHarness, json);
    if (captured && captured !== resolvedSessionId) {
      resolvedSessionId = captured;
      if (canonicalHarness === 'codex') {
        nativeProgressProbe = createCodexNativeProgressProbe(captured);
      }
      emit({ type: 'session.started', sessionId: captured });
    }
  };

  const stdout = createStdoutProcessor(request, parse, emit, updateSession, () =>
    heartbeat.markStdout()
  );
  const stderr = createStderrProcessor(request, emit);

  heartbeat.start();
  if (resolvedSessionId) emit({ type: 'session.started', sessionId: resolvedSessionId });
  emit({ type: 'turn.started' });

  // A failed required-MCP probe emits the startup error, kills the turn and
  // forces reason 'error' even if the model already ran — a Buddy turn must
  // never report success without its state tools.
  let mcpStartupFailure: string | undefined;
  const mcpStartupProbe = Promise.all(
    options.probe.map(([name, server]) => probeMcpServerStartup(name, server))
  ).then(
    () => undefined,
    (error: unknown) => {
      mcpStartupFailure = error instanceof Error ? error.message : String(error);
      emit({ type: 'error', message: mcpStartupFailure });
      killGroup();
    }
  );

  const stderrOutOfTokens = (): string | undefined => {
    const classified = classifyError(stderr.buffer().trim().split('\n').pop() ?? '');
    return classified.kind === 'out_of_tokens' ? classified.message : undefined;
  };

  const followed = followJournal(dir, {
    onStdout: (chunk) => stdout.onChunk(chunk),
    onStderr: (chunk) => stderr.onChunk(chunk),
  });

  const completed = Promise.all([followed, mcpStartupProbe])
    .then(([end]) => {
      heartbeat.stop();
      stdout.flush();
      stderr.flush();
      removeOwnedPaths(request);
      if (options.ownsJournal) rmSync(dir, { recursive: true, force: true });
      const { exitCode, signal } =
        end.kind === 'exited' ? end.status : { exitCode: null, signal: null };

      let finalReason = completionReason;
      if (mcpStartupFailure) {
        finalReason = 'error';
        if (!completeEventSeen) emit({ type: 'turn.complete', reason: 'error' });
      } else if (!completeEventSeen) {
        // out_of_tokens first: we SIGTERM the child ourselves on it, so
        // exitCode === null here means "we stopped it for credits", not killed.
        if (completionReason === 'out_of_tokens') {
          finalReason = 'out_of_tokens';
        } else if (end.kind === 'lost' && !stopRequested) {
          // The wrapper died without recording an exit: its group was SIGKILLed
          // from outside. Never a success, and distinguishable from a stop.
          finalReason = 'killed';
          emit({
            type: 'error',
            message: `${request.harness} execution was lost: its process group was killed without an exit record`,
          });
        } else if (stopRequested || exitCode === null) {
          finalReason = 'killed';
        } else if (completionReason !== 'success') {
          finalReason = completionReason;
        } else if (request.mode === 'conversation' && exitCode !== 0 && stderrOutOfTokens()) {
          // Cursor reports fatal account errors ONLY as a stderr line and exit 1,
          // no JSON (verified 2026-09-24 with an unknown model id). Run that last
          // line through the same classifier every JSON error uses, so exhausted
          // credits stay `out_of_tokens` and the memory-review ladder advances.
          finalReason = 'out_of_tokens';
          emit({ type: 'out_of_tokens', message: stderrOutOfTokens()! });
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
      return {
        reason: finalReason,
        exitCode,
        signal,
        sessionId: resolvedSessionId,
      };
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
    pid,
    journalDir: dir,
    events: queue.iterator,
    sessionId,
    completed,
    stop: (signal?: NodeJS.Signals) => {
      stopRequested = true;
      heartbeat.stop();
      killGroup(signal);
    },
  };
}
