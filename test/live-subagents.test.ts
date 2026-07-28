import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants, accessSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  type ExecuteCommandCompletion,
  type UnifiedAgentEvent,
  executeCommand,
} from '../src/run.ts';

const liveSubagentsEnabled = process.env.AGENT_CLI_LIVE_SUBAGENTS === '1';
const harness = (process.env.AGENT_CLI_LIVE_SUBAGENTS_HARNESS ?? 'codex') as 'codex';
const model = process.env.AGENT_CLI_LIVE_SUBAGENTS_MODEL ?? 'gpt-5.4-mini';
const timeoutMs = Number(process.env.AGENT_CLI_LIVE_SUBAGENTS_TIMEOUT_MS ?? 180_000);
const debugRawEvents = process.env.AGENT_CLI_LIVE_SUBAGENTS_DEBUG === '1';
const cwd = process.cwd();
const HIDE_TEST_PREFIX = '[_HIDE_TEST_]';

function requireBinary(name: string): void {
  const pathEnv = process.env.PATH ?? '';
  const parts = pathEnv.split(':').filter(Boolean);
  for (const dir of parts) {
    try {
      accessSync(`${dir}/${name}`, constants.X_OK);
      return;
    } catch {}
  }
  throw new Error(`Binary not found on PATH: ${name}`);
}

async function collectEvents(
  events: AsyncIterable<UnifiedAgentEvent>
): Promise<UnifiedAgentEvent[]> {
  const out: UnifiedAgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function errorMessages(events: UnifiedAgentEvent[]): string[] {
  return events
    .filter(
      (event): event is Extract<UnifiedAgentEvent, { type: 'error' }> => event.type === 'error'
    )
    .map((event) => event.message);
}

function assertTurnSucceeded(
  completion: ExecuteCommandCompletion,
  events: UnifiedAgentEvent[]
): void {
  const errors = errorMessages(events);
  const authError = errors.find(
    (message) =>
      message.includes('AUTH_REQUIRED:') ||
      message.includes('interactive authentication') ||
      message.includes('sign in')
  );

  if (authError) {
    assert.fail(
      `Sub-agent probe requires an authenticated ${harness} session. Log in outside the test and rerun.\n${authError}`
    );
  }

  assert.strictEqual(
    completion.reason,
    'success',
    `expected success, got ${completion.reason}. Errors: ${JSON.stringify(errors)}`
  );
  assert.deepStrictEqual(errors, [], `expected no error events, got ${JSON.stringify(errors)}`);
}

function buildPrompt(outputDir: string): string {
  const file1 = path.join(outputDir, 'file_1.md');
  const file2 = path.join(outputDir, 'file_2.md');
  const file3 = path.join(outputDir, 'file_3.md');

  return [
    HIDE_TEST_PREFIX,
    'Use the spawn_agent tool exactly three times.',
    'Spawn all three sub-agents before waiting for any of them.',
    'Each sub-agent must write exactly one file with exactly one line of text:',
    `- ${file1}`,
    `- ${file2}`,
    `- ${file3}`,
    'The file content must be exactly: test-confirmed',
    'Do not write any of these files from the main agent.',
    'After spawning them, wait for all three sub-agents to finish.',
    'After they finish, verify that all three files exist.',
    'When done, reply with exactly SUBAGENTS_OK and nothing else.',
  ].join('\n');
}

function summarizeEvents(events: UnifiedAgentEvent[]): string {
  return events
    .slice(-12)
    .map((event) => {
      switch (event.type) {
        case 'tool.use':
          return `tool.use:${event.name}`;
        case 'subagent.state':
          return `subagent.state:${event.id}:${event.status}`;
        case 'text.delta':
          return `text.delta:${JSON.stringify(event.text.slice(0, 80))}`;
        case 'progress':
          return `progress:${event.source}`;
        case 'stderr':
          return `stderr:${JSON.stringify(event.text.slice(0, 80))}`;
        case 'error':
          return `error:${event.message}`;
        case 'turn.complete':
          return `turn.complete:${event.reason}`;
        case 'session.started':
          return `session.started:${event.sessionId}`;
        case 'turn.started':
          return 'turn.started';
        case 'out_of_tokens':
          return `out_of_tokens:${event.message}`;
      }
    })
    .join('\n');
}

describe('live sub-agent probe', { skip: !liveSubagentsEnabled }, () => {
  it(
    'spawns three sub-agents that each write a confirmation file',
    { timeout: timeoutMs + 30_000 },
    async () => {
      requireBinary(harness);

      const tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-cli-live-subagents-'));
      const outputDir = path.join(tempRoot, randomUUID());

      try {
        const turn = executeCommand({
          harness,
          mode: 'conversation',
          prompt: buildPrompt(outputDir),
          cwd,
          model,
          yolo: true,
          detached: true,
          ...(debugRawEvents ? { debugRawEvents: true } : {}),
        });

        const eventsPromise = collectEvents(turn.events);
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          turn.stop('SIGKILL');
        }, timeoutMs);
        let completion: ExecuteCommandCompletion;
        try {
          completion = await turn.completed;
        } finally {
          clearTimeout(timeout);
        }
        const events = await eventsPromise;

        if (timedOut) {
          const fileStatuses = [1, 2, 3].map((index) => {
            const filePath = path.join(outputDir, `file_${index}.md`);
            try {
              return `${path.basename(filePath)}=${JSON.stringify(readFileSync(filePath, 'utf-8').trim())}`;
            } catch {
              return `${path.basename(filePath)}=missing`;
            }
          });
          assert.fail(
            `probe timed out after ${timeoutMs}ms\ncompletion=${completion.reason}\nfiles=${fileStatuses.join(', ')}\nrecent events:\n${summarizeEvents(events)}`
          );
        }

        assertTurnSucceeded(completion, events);

        const spawnEvents = events.filter(
          (event): event is Extract<UnifiedAgentEvent, { type: 'tool.use' }> =>
            event.type === 'tool.use' && event.name === 'spawn_agent'
        );
        const waitEvents = events.filter(
          (event): event is Extract<UnifiedAgentEvent, { type: 'tool.use' }> =>
            event.type === 'tool.use' && event.name === 'wait'
        );
        const subagentEvents = events.filter(
          (event): event is Extract<UnifiedAgentEvent, { type: 'subagent.state' }> =>
            event.type === 'subagent.state'
        );

        assert.strictEqual(
          spawnEvents.length,
          3,
          `expected exactly 3 spawn_agent events, got ${spawnEvents.length}`
        );
        assert.ok(waitEvents.length >= 1, 'expected at least one wait event');
        assert.strictEqual(
          new Set(subagentEvents.map((event) => event.id)).size,
          3,
          `expected 3 distinct subagent.state ids, got ${subagentEvents.map((event) => event.id).join(', ')}`
        );

        for (const index of [1, 2, 3]) {
          const filePath = path.join(outputDir, `file_${index}.md`);
          const content = readFileSync(filePath, 'utf-8').trim();
          assert.strictEqual(
            content,
            'test-confirmed',
            `unexpected content in ${filePath}: ${JSON.stringify(content)}`
          );
        }

        const finalText = events
          .filter(
            (event): event is Extract<UnifiedAgentEvent, { type: 'text.delta' }> =>
              event.type === 'text.delta'
          )
          .map((event) => event.text)
          .join('');
        assert.match(finalText, /\bSUBAGENTS_OK\b/);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  );
});
