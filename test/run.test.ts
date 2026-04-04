import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClaudeParser, executeCommand, type UnifiedAgentEvent } from '../src/run.ts';

function writeCodexShim(binDir: string): void {
  const shimPath = path.join(binDir, 'codex');
  const shimSource = `#!/usr/bin/env node
const args = process.argv.slice(2);
const sep = args.indexOf('--');
const prompt = sep >= 0 ? (args[sep + 1] ?? '') : '';
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

if (prompt === 'contract-success') {
  emit({ type: 'thread.started', thread_id: 'thread-final' });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } });
  emit({ type: 'turn.completed' });
  process.exit(0);
}

if (prompt === 'contract-no-complete') {
  emit({ type: 'thread.started', thread_id: 'thread-no-complete' });
  process.exit(7);
}

if (prompt === 'contract-missing-terminal-success-exit') {
  emit({ type: 'thread.started', thread_id: 'thread-missing-terminal' });
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } });
  process.exit(0);
}

if (prompt === 'flag-check') {
  emit({ type: 'thread.started', thread_id: 'thread-resume' });
  process.exit(0);
}

if (prompt === 'contract-stderr') {
  emit({ type: 'thread.started', thread_id: 'thread-stderr' });
  emit({ type: 'turn.started' });
  process.stderr.write('stderr line one\\n');
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
  emit({ type: 'turn.completed' });
  process.exit(0);
}

process.exit(0);
`;

  writeFileSync(shimPath, shimSource);
  chmodSync(shimPath, 0o755);
}

function writeGeminiShim(binDir: string): void {
  const shimPath = path.join(binDir, 'gemini2');
  const shimSource = `#!/usr/bin/env node
const promptIdx = process.argv.indexOf('-p');
const prompt = promptIdx >= 0 ? (process.argv[promptIdx + 1] ?? '') : '';
const resumeIdx = process.argv.indexOf('--resume');
const resumeSession = resumeIdx >= 0 ? (process.argv[resumeIdx + 1] ?? '') : '';
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');

if (prompt === 'gemini-auth-required') {
  process.stdout.write('Opening authentication page in your browser. Do you want to continue? [Y/n]:');
  process.exit(0);
}

if (prompt === 'gemini-success') {
  emit({ type: 'init', session_id: 'gemini-session-1' });
  emit({ type: 'tool_result', status: 'success', output: 'ls output' });
  emit({ type: 'message', role: 'assistant', content: 'hi from gemini' });
  emit({ type: 'result', status: 'success' });
  process.exit(0);
}

if (prompt === 'gemini-resume-success') {
  if (resumeSession !== 'gemini-session-1') {
    process.stderr.write('Use --list-sessions to see available sessions, then use --resume {number}, --resume {uuid}, or --resume latest.\\n');
    process.exit(3);
  }
  emit({ type: 'init', session_id: 'gemini-session-1' });
  emit({ type: 'message', role: 'assistant', content: 'hi again from gemini' });
  emit({ type: 'result', status: 'success' });
  process.exit(0);
}

process.exit(0);
`;

  writeFileSync(shimPath, shimSource);
  chmodSync(shimPath, 0o755);
}

async function collectEvents(events: AsyncIterable<UnifiedAgentEvent>): Promise<UnifiedAgentEvent[]> {
  const out: UnifiedAgentEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

describe('executeCommand contract', { concurrency: true }, () => {
  const originalPath = process.env.PATH ?? '';
  let tempRoot = '';
  let workspace = '';

  before(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'agent-cli-run-test-'));
    workspace = path.join(tempRoot, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeCodexShim(tempRoot);
    writeGeminiShim(tempRoot);
    process.env.PATH = `${tempRoot}:${originalPath}`;
  });

  after(() => {
    process.env.PATH = originalPath;
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('resolves final session id consistently across events, sessionId, and completed', async () => {
    const turn = executeCommand({
      harness: 'codex',
      mode: 'conversation',
      prompt: 'contract-success',
      cwd: workspace,
      model: 'gpt-5.3-codex',
      resumeSessionId: 'resume-thread',
      yolo: false,
    });

    const eventsPromise = collectEvents(turn.events);
    const completion = await turn.completed;
    const events = await eventsPromise;
    const resolvedSessionId = await turn.sessionId;

    assert.strictEqual(completion.reason, 'success');
    assert.strictEqual(completion.exitCode, 0);
    assert.strictEqual(completion.sessionId, 'thread-final');
    assert.strictEqual(resolvedSessionId, 'thread-final');

    const sessionEvents: string[] = [];
    let turnStartedCount = 0;
    const completionReasons: string[] = [];
    let sawHelloDelta = false;
    for (const event of events) {
      if (event.type === 'session.started') sessionEvents.push(event.sessionId);
      if (event.type === 'turn.started') turnStartedCount += 1;
      if (event.type === 'turn.complete') completionReasons.push(event.reason);
      if (event.type === 'text.delta' && event.text === 'hello') sawHelloDelta = true;
    }

    assert.deepStrictEqual(sessionEvents, ['resume-thread', 'thread-final']);
    assert.strictEqual(turnStartedCount, 1);
    assert.deepStrictEqual(completionReasons, ['success']);
    assert.ok(sawHelloDelta, 'expected assistant text delta from codex JSON stream');
  });

  it('falls back to error completion when process exits non-zero without terminal event', async () => {
    const turn = executeCommand({
      harness: 'codex',
      mode: 'conversation',
      prompt: 'contract-no-complete',
      cwd: workspace,
      model: 'gpt-5.3-codex',
      yolo: false,
    });

    const eventsPromise = collectEvents(turn.events);
    const completion = await turn.completed;
    const events = await eventsPromise;
    const resolvedSessionId = await turn.sessionId;

    assert.strictEqual(completion.reason, 'error');
    assert.strictEqual(completion.exitCode, 7);
    assert.strictEqual(completion.sessionId, 'thread-no-complete');
    assert.strictEqual(resolvedSessionId, 'thread-no-complete');

    const completionReasons = events
      .filter((event): event is Extract<UnifiedAgentEvent, { type: 'turn.complete' }> => event.type === 'turn.complete')
      .map((event) => event.reason);
    assert.deepStrictEqual(completionReasons, ['error']);
  });

  it('treats conversation exit without turn.complete as error even with exit code 0', async () => {
    const turn = executeCommand({
      harness: 'codex',
      mode: 'conversation',
      prompt: 'contract-missing-terminal-success-exit',
      cwd: workspace,
      model: 'gpt-5.3-codex',
      yolo: false,
    });

    const eventsPromise = collectEvents(turn.events);
    const completion = await turn.completed;
    const events = await eventsPromise;
    const resolvedSessionId = await turn.sessionId;

    assert.strictEqual(completion.reason, 'error');
    assert.strictEqual(completion.exitCode, 0);
    assert.strictEqual(completion.sessionId, 'thread-missing-terminal');
    assert.strictEqual(resolvedSessionId, 'thread-missing-terminal');

    const completionReasons = events
      .filter((event): event is Extract<UnifiedAgentEvent, { type: 'turn.complete' }> => event.type === 'turn.complete')
      .map((event) => event.reason);
    assert.deepStrictEqual(completionReasons, ['error']);

    const errors = events
      .filter((event): event is Extract<UnifiedAgentEvent, { type: 'error' }> => event.type === 'error')
      .map((event) => event.message);
    assert.ok(
      errors.some((message) => message.includes('without a terminal turn.complete event')),
      `expected missing-terminal error message; got: ${JSON.stringify(errors)}`
    );
  });

  it('uses --full-auto for codex resume without adding dangerous bypass flag', async () => {
    const turn = executeCommand({
      harness: 'codex',
      mode: 'conversation',
      prompt: 'flag-check',
      cwd: workspace,
      model: 'gpt-5.3-codex',
      resumeSessionId: 'thread-resume',
      yolo: true,
      fullAuto: true,
    });

    assert.strictEqual(turn.spec.argv[0], 'codex');
    assert.strictEqual(turn.spec.argv[1], 'exec');
    assert.strictEqual(turn.spec.argv[2], 'resume');
    assert.strictEqual(turn.spec.argv[3], 'thread-resume');
    assert.ok(turn.spec.argv.includes('--full-auto'));
    assert.ok(turn.spec.argv.includes('--json'));
    assert.ok(!turn.spec.argv.includes('--dangerously-bypass-approvals-and-sandbox'));

    await turn.completed;
  });

  // Regression: run.ts had literal '\n' strings (backslash-n) instead of real newlines on the
  // stdoutBuffer/stderrBuffer declarations and in onStderr, causing `ReferenceError: n is not
  // defined` on every executeCommand call. This test exercises both the function body init
  // (stdoutBuffer) and the onStderr handler (stderrBuffer accumulation).
  it('captures stderr events without ReferenceError (regression: literal \\n corruption)', async () => {
    const turn = executeCommand({
      harness: 'codex',
      mode: 'conversation',
      prompt: 'contract-stderr',
      cwd: workspace,
      model: 'gpt-5.3-codex',
      yolo: false,
    });

    const eventsPromise = collectEvents(turn.events);
    const completion = await turn.completed;
    const events = await eventsPromise;

    assert.strictEqual(completion.reason, 'success');
    const stderrEvents = events.filter(
      (e): e is Extract<UnifiedAgentEvent, { type: 'stderr' }> => e.type === 'stderr'
    );
    assert.ok(stderrEvents.length > 0, 'expected at least one stderr event');
    const combined = stderrEvents.map((e) => e.text).join('');
    assert.ok(combined.includes('stderr line one'), `expected stderr text; got: ${combined}`);
  });

  it('preserves explicit first-turn sessionId when provided', async () => {
    const turn = executeCommand({
      harness: 'codex',
      mode: 'conversation',
      prompt: 'contract-success',
      cwd: workspace,
      model: 'gpt-5.3-codex',
      sessionId: 'first-turn-session',
      yolo: false,
    });

    const eventsPromise = collectEvents(turn.events);
    const completion = await turn.completed;
    const events = await eventsPromise;

    const sessionEvents = events
      .filter((event): event is Extract<UnifiedAgentEvent, { type: 'session.started' }> => event.type === 'session.started')
      .map((event) => event.sessionId);

    assert.strictEqual(sessionEvents[0], 'first-turn-session');
    assert.strictEqual(completion.sessionId, 'thread-final');
  });

  it('supports gemini alias harnesses and fails fast on interactive auth stdout', async () => {
    const turn = executeCommand({
      harness: 'gemini2',
      mode: 'conversation',
      prompt: 'gemini-auth-required',
      cwd: workspace,
      model: 'gemini-3.1-pro-preview',
      yolo: false,
    });

    const eventsPromise = collectEvents(turn.events);
    const completion = await turn.completed;
    const events = await eventsPromise;

    assert.strictEqual(completion.reason, 'error');
    const errors = events
      .filter((event): event is Extract<UnifiedAgentEvent, { type: 'error' }> => event.type === 'error')
      .map((event) => event.message);
    assert.ok(
      errors.some((message) => message.includes('interactive authentication')),
      `expected auth failure message; got: ${JSON.stringify(errors)}`
    );
  });

  it('captures the real gemini session id from init output', async () => {
    const turn = executeCommand({
      harness: 'gemini2',
      mode: 'conversation',
      prompt: 'gemini-success',
      cwd: workspace,
      model: 'gemini-3.1-pro-preview',
      yolo: false,
    });

    const eventsPromise = collectEvents(turn.events);
    const completion = await turn.completed;
    const events = await eventsPromise;

    assert.strictEqual(completion.reason, 'success');
    assert.strictEqual(completion.sessionId, 'gemini-session-1');

    const sessionEvents = events.filter(
      (event): event is Extract<UnifiedAgentEvent, { type: 'session.started' }> => event.type === 'session.started'
    );
    assert.deepStrictEqual(sessionEvents.map((event) => event.sessionId), ['gemini-session-1']);

    const errors = events.filter(
      (event): event is Extract<UnifiedAgentEvent, { type: 'error' }> => event.type === 'error'
    );
    assert.strictEqual(errors.length, 0);
  });

  it('resumes gemini with the captured real session id', async () => {
    const firstTurn = executeCommand({
      harness: 'gemini2',
      mode: 'conversation',
      prompt: 'gemini-success',
      cwd: workspace,
      model: 'gemini-3.1-pro-preview',
      yolo: false,
    });

    const firstCompletion = await firstTurn.completed;
    assert.strictEqual(firstCompletion.reason, 'success');
    assert.strictEqual(firstCompletion.sessionId, 'gemini-session-1');

    const resumedTurn = executeCommand({
      harness: 'gemini2',
      mode: 'conversation',
      prompt: 'gemini-resume-success',
      cwd: workspace,
      model: 'gemini-3.1-pro-preview',
      resumeSessionId: firstCompletion.sessionId,
      yolo: false,
    });

    const eventsPromise = collectEvents(resumedTurn.events);
    const resumedCompletion = await resumedTurn.completed;
    const resumedEvents = await eventsPromise;

    assert.strictEqual(resumedTurn.spec.argv[0], 'gemini2');
    assert.ok(resumedTurn.spec.argv.includes('--resume'));
    assert.ok(resumedTurn.spec.argv.includes('gemini-session-1'));
    assert.strictEqual(resumedCompletion.reason, 'success');
    assert.strictEqual(resumedCompletion.sessionId, 'gemini-session-1');

    const errors = resumedEvents
      .filter((event): event is Extract<UnifiedAgentEvent, { type: 'error' }> => event.type === 'error')
      .map((event) => event.message);
    assert.deepStrictEqual(errors, []);

    const text = resumedEvents
      .filter((event): event is Extract<UnifiedAgentEvent, { type: 'text.delta' }> => event.type === 'text.delta')
      .map((event) => event.text)
      .join('');
    assert.match(text, /hi again from gemini/);
  });

  it('claude parser accumulates input_json_delta and emits tool.use with full input', () => {
    const parse = createClaudeParser();

    // content_block_start: tool_use with name=Bash — should NOT emit yet
    const startEvents = parse({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'toolu_abc', name: 'Bash' },
      },
    });
    assert.deepStrictEqual(startEvents, [], 'should not emit at content_block_start');

    // content_block_delta: input_json_delta chunks
    const delta1 = parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"command":"env -u CLAUDECODE' },
      },
    });
    assert.deepStrictEqual(delta1, [], 'should not emit during delta accumulation');

    const delta2 = parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: ' oompa run oompa.json"}' },
      },
    });
    assert.deepStrictEqual(delta2, [], 'should not emit during delta accumulation');

    // content_block_stop: should emit tool.use with full reconstructed input
    const stopEvents = parse({
      type: 'stream_event',
      event: { type: 'content_block_stop' },
    });
    assert.strictEqual(stopEvents.length, 1);
    const toolEvent = stopEvents[0] as Extract<UnifiedAgentEvent, { type: 'tool.use' }>;
    assert.strictEqual(toolEvent.type, 'tool.use');
    assert.strictEqual(toolEvent.name, 'Bash');
    assert.strictEqual(
      (toolEvent.input as { command: string }).command,
      'env -u CLAUDECODE oompa run oompa.json',
    );
    assert.ok(toolEvent.displayText, 'should have displayText for non-Task tools');
  });

  it('claude parser still handles text_delta during tool blocks', () => {
    const parse = createClaudeParser();

    // Text delta should pass through even without any tool block active
    const textEvents = parse({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello world' },
      },
    });
    assert.strictEqual(textEvents.length, 1);
    assert.strictEqual(textEvents[0].type, 'text.delta');
  });

  it('agent-cli run can mirror raw gemini events to stderr for debugging', () => {
    const cliPath = path.join(process.cwd(), 'src', 'cli.ts');
    const request = {
      harness: 'gemini2',
      mode: 'conversation',
      prompt: 'gemini-success',
      cwd: workspace,
      model: 'gemini-3.1-pro-preview',
      yolo: false,
      debugRawEvents: true,
    };

    const result = spawnSync(process.execPath, ['--experimental-strip-types', cliPath, 'run', '--input', '-'], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${tempRoot}:${originalPath}` },
      input: JSON.stringify(request),
      encoding: 'utf8',
    });

    assert.strictEqual(result.status, 0, `expected successful CLI run, got stderr: ${result.stderr}`);
    assert.match(result.stderr, /\[agent-cli raw gemini2 stdout\].*session_id/);
    assert.match(result.stderr, /\[agent-cli raw gemini2 stdout\].*tool_result/);
    assert.match(result.stdout, /"type":"session\.started"/);
    assert.match(result.stdout, /"type":"text\.delta"/);
  });
});
