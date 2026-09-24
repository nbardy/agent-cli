import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type UnifiedAgentEvent, executeCommand } from '../src/run.ts';

// Live proof that the CLI actually CONNECTS a --plugin-dir MCP server and runs
// its tool — the half the runner's startup probe cannot prove. Rerun after
// every `agent` update: plugin loading is undocumented surface. Costs one cheap
// model turn; enable with AGENT_CLI_LIVE_CURSOR_MCP=1.
const enabled = process.env.AGENT_CLI_LIVE_CURSOR_MCP === '1';
const model = process.env.AGENT_CLI_LIVE_CURSOR_MODEL ?? 'grok-4.7-low';
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('live cursor required MCP', { skip: !enabled }, () => {
  it('executes a tool on an injected required MCP server', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cursor-live-'));
    const logPath = join(workspace, 'calls.log');
    const turn = executeCommand({
      harness: 'cursor',
      mode: 'conversation',
      prompt: 'Call the echo tool with text hello, then reply with exactly: done',
      cwd: workspace,
      model,
      yolo: true,
      extraArgs: ['--mode', 'ask'],
      mcpServers: {
        unleashd_echo: {
          command: process.execPath,
          args: [join(fixtureDir, 'muse-mcp-echo.mjs')],
          env: { MUSE_MCP_ECHO_LOG: logPath },
          required: true,
        },
      },
    });
    const events: UnifiedAgentEvent[] = [];
    for await (const event of turn.events) events.push(event);
    const completion = await turn.completed;

    assert.strictEqual(completion.reason, 'success', JSON.stringify(events.filter((e) => e.type === 'error')));
    assert.match(readFileSync(logPath, 'utf-8'), /echo:hello/);
    assert.ok(
      events.some((event) => event.type === 'tool.use' && event.name === 'mcp__unleashd_echo__echo'),
      'expected the canonical namespaced tool.use'
    );
  });
});
