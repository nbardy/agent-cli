// Live probes of how `claude -p` treats BACKGROUND sub-agents (Agent tool with
// run_in_background) — the behaviour every Buddy turn inherits.
//
// Incident, 2026-09-25 (wave_sim "Product Engineer", session dbfcd9c4): the
// turn launched L1–L4 as background workers, answered, and went idle. Claude
// Code 2.1.282 in print mode then waited CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS
// (default 600000 = 10 min, measured from the main thread going idle) and
// wrote "Background tasks still running after 600s; terminating." to stderr,
// stopped all four workers mid-edit and exited. The Buddy reply — held until
// exit, because `result` is only emitted then — posted 20 minutes after the
// answer was written, promising reports that could never arrive. The workers
// only resumed when the owner asked "is this still running?" an hour later:
// the resume injected "4 background agents didn't finish before the previous
// session ended" and the model re-launched them with SendMessage.
//
// These tests pin both halves so a Claude Code upgrade that changes either
// shows up here first:
//   1. the final answer is HELD until background agents finish (so a reply
//      posted on turn.complete cannot report progress — progress must be an
//      explicit post/reply tool call mid-turn);
//   2. the print-mode ceiling stops unfinished agents and exits `success`,
//      and a --resume reports them as stopped.
//
// Run: AGENT_CLI_LIVE_CLAUDE_BG=1 node --experimental-strip-types --test \
//        test/live-claude-background-agents.test.ts
// Costs a few cents of model time; takes ~2 minutes.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { type UnifiedAgentEvent, executeCommand } from '../src/run.ts';

const enabled = process.env.AGENT_CLI_LIVE_CLAUDE_BG === '1';
const model = process.env.AGENT_CLI_LIVE_CLAUDE_BG_MODEL ?? 'claude-sonnet-5';
const CEILING_ENV = 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS';

type Timed = { at: number; event: UnifiedAgentEvent };

async function runTurn(
  prompt: string,
  cwd: string,
  opts: { resumeSessionId?: string; timeoutMs: number }
) {
  const started = Date.now();
  const turn = executeCommand({
    harness: 'claude',
    mode: 'conversation',
    prompt,
    cwd,
    model,
    yolo: true,
    detached: true,
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
  });
  const events: Timed[] = [];
  const collected = (async () => {
    for await (const event of turn.events) events.push({ at: Date.now() - started, event });
  })();
  const timer = setTimeout(() => turn.stop('SIGKILL'), opts.timeoutMs);
  try {
    const completion = await turn.completed;
    await collected;
    return { completion, events, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function firstAt(events: Timed[], type: UnifiedAgentEvent['type']): number {
  const hit = events.find((e) => e.event.type === type);
  assert.ok(hit, `no ${type} event; saw ${events.map((e) => e.event.type).join(',')}`);
  return hit.at;
}

function stderrText(events: Timed[]): string {
  return events.map((e) => (e.event.type === 'stderr' ? e.event.text : '')).join('');
}

// One background worker that sleeps, then writes a marker. The main thread must
// not wait for it: it answers LAUNCHED and ends its turn. The sleep is python,
// not `sleep N && …`: Claude Code's Bash tool refuses a leading `sleep N`
// ("Blocked: sleep 30 followed by: …"), which silently turned the first
// version of this test into a no-op worker.
function backgroundWorkerPrompt(marker: string, sleepSeconds: number): string {
  const command = `python3 -c "import time; time.sleep(${sleepSeconds}); open('${marker}','w').write('done')"`;
  return [
    'Use the Agent tool exactly once, with run_in_background set to true.',
    `The sub-agent's task: run the Bash command \`${command}\``,
    'in the FOREGROUND (not run_in_background), then reply "worker done".',
    'Do not run that command yourself and do not wait for the sub-agent.',
    'Right after launching it, reply with exactly LAUNCHED and end your turn.',
    'If you are later notified that the sub-agent finished, reply with exactly WORKER_FINISHED.',
  ].join('\n');
}

function transcriptPath(sessionId: string): string {
  const root = path.join(homedir(), '.claude', 'projects');
  for (const dir of readdirSync(root)) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  assert.fail(`no transcript for session ${sessionId} under ${root}`);
}

describe('live: claude -p background sub-agents', { skip: !enabled }, () => {
  it('holds the final answer until a background agent finishes', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-bg-hold-'));
    const marker = path.join(dir, 'worker.done');
    const previous = process.env[CEILING_ENV];
    delete process.env[CEILING_ENV];
    try {
      const { completion, events } = await runTurn(backgroundWorkerPrompt(marker, 30), dir, {
        timeoutMs: 200_000,
      });
      assert.equal(completion.reason, 'success');
      // The worker ran to completion: print mode waited for it.
      assert.equal(readFileSync(marker, 'utf-8').trim(), 'done');
      // The answer text streamed early, but turn.complete (what Unleashd
      // posts on) came only after the 30 s worker — so an interim "still
      // running" reply cannot ride on the final answer.
      const textAt = firstAt(events, 'text.delta');
      const completeAt = firstAt(events, 'turn.complete');
      assert.ok(
        completeAt - textAt >= 20_000,
        `turn.complete ${completeAt}ms should trail first text ${textAt}ms by the worker's sleep`
      );
    } finally {
      if (previous === undefined) delete process.env[CEILING_ENV];
      else process.env[CEILING_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'stops unfinished background agents at the print-mode ceiling; resume reports them stopped',
    { timeout: 300_000 },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'claude-bg-ceiling-'));
      const marker = path.join(dir, 'worker.done');
      const previous = process.env[CEILING_ENV];
      process.env[CEILING_ENV] = '10000';
      try {
        const first = await runTurn(backgroundWorkerPrompt(marker, 120), dir, {
          timeoutMs: 110_000,
        });
        // Reported as a clean success even though work was killed — nothing
        // in the completion reason tells the caller workers were abandoned.
        assert.equal(first.completion.reason, 'success');
        assert.ok(first.elapsedMs < 100_000, `exited after ${first.elapsedMs}ms, not at ceiling`);
        assert.match(
          stderrText(first.events),
          /Background tasks still running after 10s; terminating/
        );
        assert.equal(existsSync(marker), false, 'worker should have been stopped before writing');

        const sessionId = first.completion.sessionId;
        assert.ok(sessionId, 'first turn produced no session id');
        // Ceiling stays at 10 s: if the model relaunches the stopped worker,
        // the resume must not sit out its 120 s sleep.
        const resumed = await runTurn('Reply with exactly RESUMED.', dir, {
          resumeSessionId: sessionId,
          timeoutMs: 120_000,
        });
        assert.equal(resumed.completion.reason, 'success');
        // The resume is the ONLY place the stop surfaces: an injected
        // task-notification the model sees as its next user message.
        assert.match(
          readFileSync(transcriptPath(sessionId), 'utf-8'),
          // "Background agent \"X\" didn't finish…" for one, "4 background
          // agents didn't finish…" for several.
          /didn't finish before the previous session ended/
        );
      } finally {
        if (previous === undefined) delete process.env[CEILING_ENV];
        else process.env[CEILING_ENV] = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  // The raw stream is what a fix builds on, so pin it below the parser: every
  // model turn gets its own `result`, but ALL of them are flushed only at exit
  // (the LAUNCHED result waits behind the worker), while the background task's
  // lifecycle streams live as `system` events. A live "workers running" view
  // must read task_started/task_notification; it cannot wait for `result`.
  it(
    'streams task lifecycle live but flushes every result at exit',
    { timeout: 240_000 },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'claude-bg-raw-'));
      const marker = path.join(dir, 'worker.done');
      const previous = process.env[CEILING_ENV];
      delete process.env[CEILING_ENV];
      try {
        const started = Date.now();
        const seen: { at: number; type: string; subtype: string }[] = [];
        const child = spawn(
          'claude',
          [
            '-p',
            '--model',
            model,
            '--dangerously-skip-permissions',
            '--verbose',
            '--output-format',
            'stream-json',
            backgroundWorkerPrompt(marker, 30),
          ],
          { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] }
        );
        let buffer = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const obj = JSON.parse(line) as { type: string; subtype?: string };
            seen.push({ at: Date.now() - started, type: obj.type, subtype: obj.subtype ?? '' });
          }
        });
        const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
        assert.equal(exitCode, 0);
        assert.equal(readFileSync(marker, 'utf-8').trim(), 'done');

        const at = (type: string, subtype: string) => {
          const hit = seen.find((e) => e.type === type && e.subtype === subtype);
          assert.ok(
            hit,
            `no ${type}/${subtype}; saw ${seen.map((e) => `${e.type}/${e.subtype}`).join(',')}`
          );
          return hit.at;
        };
        const results = seen.filter((e) => e.type === 'result');
        assert.ok(results.length >= 2, `expected a result per model turn, got ${results.length}`);
        const taskStarted = at('system', 'task_started');
        const taskDone = at('system', 'task_notification');
        assert.ok(taskDone - taskStarted >= 20_000, 'task events should bracket the 30 s worker');
        for (const result of results) {
          assert.ok(
            result.at >= taskDone,
            `a result at ${result.at}ms was flushed before the worker finished`
          );
        }
      } finally {
        if (previous === undefined) delete process.env[CEILING_ENV];
        else process.env[CEILING_ENV] = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
