import assert from 'node:assert/strict';
import { accessSync, constants, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  type ExecuteCommandCompletion,
  type UnifiedAgentEvent,
  executeCommand,
} from '../src/run.ts';

// Behavioral fail-closed coverage for the muse required-MCP contract
// (design invariant I11): a required server that cannot start must abort the
// run, and a healthy one must actually execute. Needs real muse credentials;
// enable explicitly. Mirrors the live-gemini smoke gate.
const liveMuseMcpEnabled = process.env.AGENT_CLI_LIVE_MUSE_MCP === '1';
const model = process.env.AGENT_CLI_LIVE_MUSE_MODEL ?? 'muse-spark-1.3-contributor';
const cwd = process.cwd();
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function requireBinary(name: string): void {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
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

describe('live muse required MCP', { skip: !liveMuseMcpEnabled }, () => {
  it('aborts the run when a required MCP server cannot start', async () => {
    requireBinary('muse');

    const turn = executeCommand({
      harness: 'muse',
      mode: 'conversation',
      prompt: 'Reply with exactly: should never print',
      cwd,
      model,
      yolo: true,
      mcpServers: {
        unleashd_dead: {
          kind: 'stdio',
          command: '/nonexistent-live-probe-binary',
          args: [],
          required: true,
        },
      },
    });

    const eventsPromise = collectEvents(turn.events);
    const completion: ExecuteCommandCompletion = await turn.completed;
    const events = await eventsPromise;

    assert.strictEqual(
      completion.reason,
      'error',
      `expected fail-closed error, got ${completion.reason}`
    );
    assert.match(
      errorMessages(events).join('\n'),
      /MCP server `unleashd_dead` failed during startup/,
      'expected the MCP startup failure to surface'
    );
  });

  it('executes tools on a healthy required MCP server', async () => {
    requireBinary('muse');

    const logPath = join(mkdtempSync(join(tmpdir(), 'muse-live-')), 'calls.log');
    const turn = executeCommand({
      harness: 'muse',
      mode: 'conversation',
      prompt: 'Call the echo tool with text hello, then reply with exactly: done',
      cwd,
      model,
      yolo: true,
      mcpServers: {
        unleashd_echo: {
          kind: 'stdio',
          command: process.execPath,
          args: [join(fixtureDir, 'muse-mcp-echo.mjs')],
          env: { MUSE_MCP_ECHO_LOG: logPath },
          required: true,
        },
      },
    });

    const eventsPromise = collectEvents(turn.events);
    const completion: ExecuteCommandCompletion = await turn.completed;
    const events = await eventsPromise;

    assert.strictEqual(
      completion.reason,
      'success',
      `expected success, got ${completion.reason}. Errors: ${JSON.stringify(errorMessages(events))}`
    );
    assert.match(
      readFileSync(logPath, 'utf-8'),
      /echo:hello/,
      'expected the fixture MCP server to record the tool call'
    );
    assert.ok(
      events.some(
        (event) => event.type === 'tool.use' && event.name === 'mcp__unleashd_echo__echo'
      ),
      'expected a tool.use event for the namespaced MCP tool'
    );
  });
});
