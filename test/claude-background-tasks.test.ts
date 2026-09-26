import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createClaudeParser } from '../src/parsers/claude.ts';
import type { UnifiedAgentEvent } from '../src/runtime-types.ts';

/**
 * Recorded from claude 2.1.283 (`-p --verbose --include-partial-messages
 * --output-format stream-json`, the flags agent-cli passes) on a prompt that
 * launches one `Agent` with run_in_background; the agent runs a foreground
 * Bash, which Claude also tracks as a (non-background) task. The init line was
 * trimmed to drop the local plugin/MCP inventory.
 *
 * Regression: the parser dropped every task_* system line, so a consumer could
 * see a background launch (the tool call) but never its end. Unleashd's turn
 * watchdog widened its idle budget on the launch and could never narrow it.
 */
const FIXTURE = new URL('./fixtures/claude-2.1.283-background-agent.jsonl', import.meta.url);

function parseFixture(): UnifiedAgentEvent[] {
  const parser = createClaudeParser();
  return readFileSync(FIXTURE, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => parser(JSON.parse(line)));
}

test('claude background agent: launch, task start and task finish reach the unified stream in order', () => {
  const events = parseFixture();
  const launch = events.findIndex((e) => e.type === 'tool.use' && e.name === 'Agent');
  assert.ok(launch >= 0, 'the Agent tool_use is emitted');
  const agentUse = events[launch] as Extract<UnifiedAgentEvent, { type: 'tool.use' }>;
  assert.equal(agentUse.input.run_in_background, true);

  const tasks = events.filter(
    (e): e is Extract<UnifiedAgentEvent, { type: 'task.started' | 'task.finished' }> =>
      e.type === 'task.started' || e.type === 'task.finished'
  );
  assert.deepEqual(
    tasks.map((e) =>
      e.type === 'task.started' ? `start ${e.taskId} bg=${e.background}` : `end ${e.taskId} ${e.status}`
    ),
    [
      'start a97f225bcca69d67f bg=true',
      'start bkpl519cj bg=false',
      'end bkpl519cj completed',
      'end a97f225bcca69d67f completed',
    ]
  );
  const agentStart = events.findIndex((e) => e.type === 'task.started' && e.background);
  assert.ok(agentStart > launch, 'the task starts after the tool call that launched it');
});
