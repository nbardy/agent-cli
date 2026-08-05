import {
  HEARTBEAT_CHECK_INTERVAL_MS,
  HEARTBEAT_SILENCE_THRESHOLD_MS,
} from './constants/timeouts.ts';
import type { NativeSessionProgress } from './native-progress.ts';
import type { StdoutStreamState, UnifiedAgentEvent } from './runtime-types.ts';

type TimerHandle = ReturnType<typeof setInterval>;

interface HeartbeatRuntime {
  now?: () => number;
  setIntervalFn?: (callback: () => void, intervalMs: number) => TimerHandle;
  clearIntervalFn?: (timer: TimerHandle) => void;
  checkIntervalMs?: number;
  silenceThresholdMs?: number;
  nativeProgress?: () => NativeSessionProgress | null;
  stdoutState?: () => StdoutStreamState | null;
}

export function createHeartbeat(
  enabled: boolean,
  emit: (event: UnifiedAgentEvent) => void,
  runtime: HeartbeatRuntime = {}
) {
  const now = runtime.now ?? Date.now;
  const setIntervalFn = runtime.setIntervalFn ?? setInterval;
  const clearIntervalFn = runtime.clearIntervalFn ?? clearInterval;
  const checkIntervalMs = runtime.checkIntervalMs ?? HEARTBEAT_CHECK_INTERVAL_MS;
  const silenceThresholdMs = runtime.silenceThresholdMs ?? HEARTBEAT_SILENCE_THRESHOLD_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastUnifiedEventAt = now();
  let lastStdoutAt = now();
  let sawMeaningfulContent = false;

  return {
    start() {
      if (!enabled || timer) return;
      timer = setIntervalFn(() => {
        const timestamp = now();
        const unifiedEventSilenceMs = timestamp - lastUnifiedEventAt;
        if (unifiedEventSilenceMs < silenceThresholdMs) return;
        const nativeProgress = runtime.nativeProgress?.() ?? null;
        const stdoutState = runtime.stdoutState?.() ?? null;
        emit({
          type: 'progress',
          source: 'agent-cli.heartbeat',
          data: {
            unifiedEventSilentSeconds: Math.round(unifiedEventSilenceMs / 1000),
            rawStdoutSilentSeconds: Math.round((timestamp - lastStdoutAt) / 1000),
            phase: sawMeaningfulContent ? 'running' : 'startup',
            ...(stdoutState
              ? {
                  stdoutStreamEvent: stdoutState.event,
                  stdoutReadableFlowing: stdoutState.readableFlowing,
                  stdoutReadableLengthBytes: stdoutState.readableLength,
                }
              : {}),
            ...(nativeProgress
              ? {
                  nativeSessionAvailable: nativeProgress.available,
                  nativeSessionAdvanced: nativeProgress.advanced,
                  nativeSessionSilentSeconds: nativeProgress.silentSeconds,
                  ...(nativeProgress.sizeBytes !== undefined
                    ? { nativeSessionSizeBytes: nativeProgress.sizeBytes }
                    : {}),
                }
              : {}),
          },
        });
      }, checkIntervalMs);
    },
    stop() {
      if (!timer) return;
      clearIntervalFn(timer);
      timer = null;
    },
    markStdout() {
      lastStdoutAt = now();
    },
    markUnifiedEvent() {
      lastUnifiedEventAt = now();
    },
    markMeaningful() {
      sawMeaningfulContent = true;
    },
    sawMeaningfulContent() {
      return sawMeaningfulContent;
    },
  };
}
