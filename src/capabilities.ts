import type {
  CapabilityEncoding,
  CapabilityName,
  CapabilityReport,
  Enforcement,
  TurnCapabilities,
} from './types.ts';
import { CAPABILITY_NAMES } from './types.ts';

// Turn capabilities (types.ts `TurnCapabilities`): the one canonical description of what a turn
// may do. Each harness config owns its own encoding (`HarnessConfig.capabilities`, beside the
// rest of its CLI syntax); this module holds what every encoding shares. The lookup by harness
// (`capabilityReport`) is in harnesses/index.ts, so the configs can import this without a cycle.

export const ENFORCED: Enforcement = { t: 'enforced' };
export const advisory = (reason: string): Enforcement => ({ t: 'advisory', reason });

/** Every capability advisory for one reason (a harness with no mapping). */
export const allAdvisory = (reason: string): CapabilityReport =>
  Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, advisory(reason)])) as {
    [K in CapabilityName]: Enforcement;
  };

/** The encoding of a harness whose CLI flags have not been mapped: it runs as an ordinary turn. */
export const unenforced =
  (harness: string) =>
  (_caps: TurnCapabilities): CapabilityEncoding => ({
    t: 'unenforced',
    reason: `${harness}: capability sets are not mapped to its flags yet, so the turn runs unrestricted`,
  });

/** What an encoding reports, per capability. */
export const reportOf = (encoding: CapabilityEncoding): CapabilityReport =>
  REPORT[encoding.t](encoding as never);
const REPORT: {
  readonly [K in CapabilityEncoding['t']]: (
    e: Extract<CapabilityEncoding, { t: K }>
  ) => CapabilityReport;
} = {
  enforcing: (e) => e.report,
  unenforced: (e) => allAdvisory(e.reason),
};
