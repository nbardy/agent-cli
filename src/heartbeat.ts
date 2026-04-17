import {
  HEARTBEAT_CHECK_INTERVAL_MS,
  HEARTBEAT_MAX_SILENCE_MS,
  HEARTBEAT_SILENCE_THRESHOLD_MS,
} from './constants/timeouts.ts';
import type { UnifiedAgentEvent } from './runtime-types.ts';

export function createHeartbeat(enabled: boolean, emit: (event: UnifiedAgentEvent) => void) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastStdoutAt = Date.now();
  let sawMeaningfulContent = false;

  return {
    start() {
      if (!enabled || timer) return;
      timer = setInterval(() => {
        if (!sawMeaningfulContent) return;
        const silenceMs = Date.now() - lastStdoutAt;
        if (silenceMs < HEARTBEAT_SILENCE_THRESHOLD_MS) return;
        if (silenceMs > HEARTBEAT_MAX_SILENCE_MS) {
          this.stop();
          return;
        }
        emit({
          type: 'progress',
          source: 'agent-cli.heartbeat',
          data: { silentSeconds: Math.round(silenceMs / 1000) },
        });
      }, HEARTBEAT_CHECK_INTERVAL_MS);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    markStdout() {
      lastStdoutAt = Date.now();
    },
    markMeaningful() {
      sawMeaningfulContent = true;
    },
    sawMeaningfulContent() {
      return sawMeaningfulContent;
    },
  };
}
