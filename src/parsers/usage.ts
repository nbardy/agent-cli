import type { TokenUsage } from '../runtime-types.ts';

// Missing classes once consumed an expedition's entire cap ($0.87 charged for $0.118).
// Guard: usage.test.ts pricing classes table. Only a reported zero permits zero cache tiers.
export function tokenUsage(
  input: number | undefined,
  output: number | undefined,
  cacheRead: number | undefined,
  cacheWrite: number | undefined,
  cacheWrite5m?: number,
  cacheWrite1h?: number,
): TokenUsage {
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  )
    return {
      t: 'unreported',
      why: 'Harness omitted input, output, cached read or cache write tokens',
    };
  if (cacheWrite === 0) {
    cacheWrite5m = 0;
    cacheWrite1h = 0;
  }
  if (
    cacheWrite5m === undefined ||
    cacheWrite1h === undefined ||
    cacheWrite5m + cacheWrite1h !== cacheWrite
  )
    return {
      t: 'unreported',
      why: 'Harness omitted cache-write tiers or their sum differs from cache creation',
    };
  const values = [input, output, cacheRead, cacheWrite5m, cacheWrite1h];
  if (values.some((n) => !Number.isSafeInteger(n) || n < 0))
    return { t: 'unreported', why: 'Harness reported invalid token counts' };
  return { t: 'reported', input, output, cacheRead, cacheWrite5m, cacheWrite1h };
}
