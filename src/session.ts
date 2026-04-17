import { canonicalizeHarness, getHarness } from './harnesses/index.ts';
import { asObject, asString } from './json-utils.ts';
import type { ExecuteCommandRequest } from './runtime-types.ts';
import type { Harness } from './types.ts';

export interface PreparedSession {
  buildSessionId?: string;
  resume: boolean;
  fork: boolean;
  resolvedSessionId: string;
}

export function prepareSession(request: ExecuteCommandRequest): PreparedSession {
  const canonicalHarness = canonicalizeHarness(request.harness);
  if (request.forkSessionId) {
    const harnessCfg = getHarness(canonicalHarness);
    if (harnessCfg.sessionForkFlags) {
      return { buildSessionId: request.forkSessionId, resume: false, fork: true, resolvedSessionId: '' };
    }
    if (harnessCfg.emulateFork) {
      const { newSessionId } = harnessCfg.emulateFork(request.forkSessionId);
      return { buildSessionId: newSessionId, resume: true, fork: false, resolvedSessionId: newSessionId };
    }
    throw new Error(`Harness "${canonicalHarness}" does not support fork.`);
  }

  const buildSessionId = request.resumeSessionId ?? request.sessionId;
  return { buildSessionId, resume: !!request.resumeSessionId, fork: false, resolvedSessionId: buildSessionId ?? '' };
}

export function captureSessionIdFromJson(harness: Harness, json: unknown): string | undefined {
  const obj = asObject(json);
  if (!obj) return undefined;
  if (harness === 'codex' && obj.type === 'thread.started') {
    return asString(obj.thread_id);
  }
  if (harness === 'opencode') {
    const part = asObject(obj.part);
    return asString(
      obj.sessionID ??
        obj.sessionId ??
        obj.session_id ??
        part?.sessionID ??
        part?.sessionId ??
        part?.session_id
    );
  }
  if (harness === 'claude' || harness === 'gemini' || harness === 'cursor') {
    return asString(obj.session_id) ?? asString(obj.sessionId);
  }
  return undefined;
}
