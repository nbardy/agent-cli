function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export const HEARTBEAT_CHECK_INTERVAL_MS = readPositiveIntEnv(
  'AGENT_CLI_HEARTBEAT_CHECK_INTERVAL_MS',
  30_000
);
export const HEARTBEAT_SILENCE_THRESHOLD_MS = readPositiveIntEnv(
  'AGENT_CLI_HEARTBEAT_SILENCE_THRESHOLD_MS',
  25_000
);
export const HEARTBEAT_MAX_SILENCE_MS = readPositiveIntEnv(
  'AGENT_CLI_HEARTBEAT_MAX_SILENCE_MS',
  20 * 60_000
);
