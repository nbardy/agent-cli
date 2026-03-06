import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
import { executeCommand, type ExecuteCommandCompletion, type UnifiedAgentEvent } from '../src/run';

const liveGeminiEnabled = process.env.AGENT_CLI_LIVE_GEMINI === '1';
const harness = (process.env.AGENT_CLI_LIVE_GEMINI_HARNESS ?? 'gemini') as 'gemini' | `gemini${number}`;
const model = process.env.AGENT_CLI_LIVE_GEMINI_MODEL ?? 'gemini-3.1-pro-preview';
const cwd = process.cwd();

function requireBinary(name: string): void {
  const path = process.env.PATH ?? '';
  const parts = path.split(':').filter(Boolean);
  for (const dir of parts) {
    try {
      accessSync(`${dir}/${name}`, constants.X_OK);
      return;
    } catch {
      continue;
    }
  }
  throw new Error(`Binary not found on PATH: ${name}`);
}

async function collectEvents(events: AsyncIterable<UnifiedAgentEvent>): Promise<UnifiedAgentEvent[]> {
  const out: UnifiedAgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function errorMessages(events: UnifiedAgentEvent[]): string[] {
  return events
    .filter((event): event is Extract<UnifiedAgentEvent, { type: 'error' }> => event.type === 'error')
    .map((event) => event.message);
}

function assertTurnSucceeded(
  label: string,
  completion: ExecuteCommandCompletion,
  events: UnifiedAgentEvent[],
): void {
  const errors = errorMessages(events);
  const authError = errors.find((message) =>
    message.includes('AUTH_REQUIRED:') ||
    message.includes('interactive authentication') ||
    message.includes('Opening authentication page in your browser')
  );

  if (authError) {
    assert.fail(
      `${label}: Gemini live smoke requires an authenticated ${harness} session. Log in outside the test and rerun.\n${authError}`
    );
  }

  assert.strictEqual(
    completion.reason,
    'success',
    `${label}: expected success, got ${completion.reason}. Errors: ${JSON.stringify(errors)}`
  );
  assert.deepStrictEqual(errors, [], `${label}: expected no error events, got ${JSON.stringify(errors)}`);
}

describe('live gemini smoke', { skip: !liveGeminiEnabled }, () => {
  it('runs a real conversation turn and resumes it with the real gemini session id', async () => {
    requireBinary(harness);

    const firstTurn = executeCommand({
      harness,
      mode: 'conversation',
      prompt: 'Reply with exactly FIRST_OK and then stop.',
      cwd,
      model,
      yolo: false,
    });

    const firstEventsPromise = collectEvents(firstTurn.events);
    const firstCompletion = await firstTurn.completed;
    const firstEvents = await firstEventsPromise;

    assertTurnSucceeded('first turn', firstCompletion, firstEvents);
    assert.match(firstCompletion.sessionId, /^[0-9a-f-]{36}$/i);

    const firstText = firstEvents
      .filter((event): event is Extract<UnifiedAgentEvent, { type: 'text.delta' }> => event.type === 'text.delta')
      .map((event) => event.text)
      .join('');
    assert.match(firstText, /\bFIRST_OK\b/, `expected live Gemini response to contain FIRST_OK, got: ${firstText}`);

    const resumedTurn = executeCommand({
      harness,
      mode: 'conversation',
      prompt: 'Reply with exactly RESUME_OK and then stop.',
      cwd,
      model,
      resumeSessionId: firstCompletion.sessionId,
      yolo: false,
    });

    const resumedEventsPromise = collectEvents(resumedTurn.events);
    const resumedCompletion = await resumedTurn.completed;
    const resumedEvents = await resumedEventsPromise;

    assertTurnSucceeded('resume turn', resumedCompletion, resumedEvents);
    assert.strictEqual(resumedCompletion.sessionId, firstCompletion.sessionId);

    const resumedText = resumedEvents
      .filter((event): event is Extract<UnifiedAgentEvent, { type: 'text.delta' }> => event.type === 'text.delta')
      .map((event) => event.text)
      .join('');
    assert.match(
      resumedText,
      /\bRESUME_OK\b/,
      `expected resumed live Gemini response to contain RESUME_OK, got: ${resumedText}`
    );

    const debugTurn = executeCommand({
      harness,
      mode: 'conversation',
      prompt: 'Reply with exactly DEBUG_OK and then stop.',
      cwd,
      model,
      yolo: false,
      debugRawEvents: true,
    });

    const debugEventsPromise = collectEvents(debugTurn.events);
    const debugCompletion = await debugTurn.completed;
    const debugEvents = await debugEventsPromise;
    assertTurnSucceeded('debug turn', debugCompletion, debugEvents);
  });
});
