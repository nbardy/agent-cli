import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import type { CommandSpec, HarnessName } from './types.ts';
import type { TurnMode } from './runtime-types.ts';

/**
 * A provider execution journaled on disk, so it can outlive the process that
 * started it. The CLI's stdout/stderr go to FILES, never to pipes: a piped
 * child dies of SIGPIPE soon after its reader exits (measured 2026-08-21; see
 * unleashd agent_notes/2026-08-21_turn-lifecycle-design.md §4b), while a
 * file-backed child runs to completion. Every reader, including the process
 * that spawned it, follows the files, so a later process adopts a live
 * execution by following the same directory from byte 0.
 *
 *   execution.json  parser inputs, owned temp paths (written before spawn)
 *   stdin           the prompt for stdin harnesses
 *   pid             the wrapper's pid = its process group (written right after spawn)
 *   stdout, stderr  append-only provider output
 *   exit.json       the provider's exit status, written by the wrapper (tmp + rename)
 *
 * The wrapper is `sh` with `trap : TERM INT`: a group SIGTERM reaches both, the
 * CLI (traps reset on exec) dies, and the shell survives long enough to record
 * the status. Only SIGKILL of the group leaves no exit.json: that is `lost`.
 * Design: unleashd agent_notes/2026-09-30_execution-adoption-design.md.
 */
export interface ExecutionRecord {
  readonly version: 1;
  readonly harness: HarnessName;
  readonly mode: TurnMode;
  readonly debugRawEvents: boolean;
  /** The session id known before spawn (resume/fork); '' when the CLI will name one. */
  readonly sessionId: string;
  /** Harness temp config for this process only, removed once it is gone. */
  readonly ownedPaths: readonly string[];
  readonly startedAt: string;
}

/** Where an execution is, read from its directory alone. */
export type ExecutionState =
  | { kind: 'running'; pid: number }
  | { kind: 'exited'; status: ExitStatus }
  | { kind: 'lost'; pid: number }
  | { kind: 'unstarted' };

/** The wrapper's `$?`: a code below 128, else 128 + the signal number. */
export interface ExitStatus {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export const journalFile = {
  record: (dir: string) => path.join(dir, 'execution.json'),
  stdin: (dir: string) => path.join(dir, 'stdin'),
  pid: (dir: string) => path.join(dir, 'pid'),
  stdout: (dir: string) => path.join(dir, 'stdout'),
  stderr: (dir: string) => path.join(dir, 'stderr'),
  exit: (dir: string) => path.join(dir, 'exit.json'),
};

// $1 = journal dir, the rest = argv. `: TERM INT` (not '') so the CLI's own
// dispositions stay default after exec.
const WRAPPER = `trap : TERM INT
d="$1"; shift
"$@" <"$d/stdin" >>"$d/stdout" 2>>"$d/stderr"
s=$?
printf '{"status":%d}\\n' "$s" >"$d/exit.tmp" && mv "$d/exit.tmp" "$d/exit.json"`;

export function writeExecutionRecord(dir: string, record: ExecutionRecord): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(journalFile.record(dir), `${JSON.stringify(record)}\n`);
}

export function readExecutionRecord(dir: string): ExecutionRecord {
  const record = JSON.parse(fs.readFileSync(journalFile.record(dir), 'utf8')) as ExecutionRecord;
  if (record.version !== 1) throw new Error(`Unsupported execution journal version in ${dir}`);
  return record;
}

/** Spawn the wrapper detached (own session and group), stdio to files, no pipes. */
export function spawnJournaled(
  dir: string,
  bin: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin: string }
): number {
  fs.writeFileSync(journalFile.stdin(dir), options.stdin, { mode: 0o600 });
  fs.writeFileSync(journalFile.stdout(dir), '', { mode: 0o600 });
  fs.writeFileSync(journalFile.stderr(dir), '', { mode: 0o600 });
  const child = spawn('/bin/sh', ['-c', WRAPPER, 'agent-cli-journal', dir, bin, ...args], {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
    ...(options.env ? { env: options.env } : {}),
  });
  if (child.pid === undefined) {
    // spawn of /bin/sh itself failed; the error event carries the reason.
    throw new Error(`Could not start the execution wrapper for ${bin}`);
  }
  // Same synchronous tick as spawn: no await between, so no reader can see the
  // process without its pid file (short of a SIGKILL inside this statement).
  fs.writeFileSync(journalFile.pid(dir), String(child.pid), { mode: 0o600 });
  // The wrapper's lifetime is its own; nothing here keeps the event loop alive.
  child.unref();
  child.on('error', () => undefined);
  return child.pid;
}

export function executionState(dir: string): ExecutionState {
  const status = readExit(dir);
  if (status) return { kind: 'exited', status };
  const pid = readPid(dir);
  if (pid === null) return { kind: 'unstarted' };
  if (isOwnWrapper(pid, dir)) return { kind: 'running', pid };
  // The wrapper may have written exit.json between the two reads.
  const late = readExit(dir);
  return late ? { kind: 'exited', status: late } : { kind: 'lost', pid };
}

export function readPid(dir: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(journalFile.pid(dir), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readExit(dir: string): ExitStatus | null {
  let text: string;
  try {
    text = fs.readFileSync(journalFile.exit(dir), 'utf8');
  } catch {
    return null;
  }
  const status = (JSON.parse(text) as { status: number }).status;
  return status < 128
    ? { exitCode: status, signal: null }
    : { exitCode: null, signal: signalName(status - 128) };
}

function signalName(number: number): NodeJS.Signals | null {
  const entry = Object.entries(constants.signals).find(([, value]) => value === number);
  return (entry?.[0] as NodeJS.Signals | undefined) ?? null;
}

/**
 * Alive AND still our wrapper: a reused pid runs some other command line,
 * which never names this journal directory.
 */
export function isOwnWrapper(pid: number, dir: string): boolean {
  if (!isAlive(pid)) return false;
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return command.includes(dir);
  } catch {
    return false;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signal the whole group; a group that is already gone is not an error. */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}

export interface FollowCallbacks {
  onStdout(chunk: Buffer): void;
  onStderr(chunk: Buffer): void;
}

const FOLLOW_INTERVAL_MS = 50;
const LIVENESS_EVERY_TICKS = 20;

/**
 * Deliver the journal's output in order from byte 0, then resolve once the
 * execution ended and every byte written before that was delivered. `lost`
 * when the wrapper died without an exit record (a SIGKILLed group).
 */
export function followJournal(
  dir: string,
  callbacks: FollowCallbacks
): Promise<{ kind: 'exited'; status: ExitStatus } | { kind: 'lost' }> {
  const stdout = openTail(journalFile.stdout(dir));
  const stderr = openTail(journalFile.stderr(dir));
  const pid = readPid(dir);
  const drain = () => {
    for (const chunk of stdout.read()) callbacks.onStdout(chunk);
    for (const chunk of stderr.read()) callbacks.onStderr(chunk);
  };
  const finish = () => {
    drain();
    stdout.close();
    stderr.close();
  };
  return new Promise((resolve) => {
    let ticks = 0;
    const tick = () => {
      drain();
      const status = readExit(dir);
      if (status) {
        finish();
        return resolve({ kind: 'exited', status });
      }
      if (++ticks % LIVENESS_EVERY_TICKS === 0 && (pid === null || !isAlive(pid))) {
        const late = readExit(dir);
        finish();
        return resolve(late ? { kind: 'exited', status: late } : { kind: 'lost' });
      }
      setTimeout(tick, FOLLOW_INTERVAL_MS);
    };
    tick();
  });
}

function openTail(file: string) {
  const fd = fs.openSync(file, 'r');
  let offset = 0;
  const buffer = Buffer.alloc(64 * 1024);
  return {
    read(): Buffer[] {
      const chunks: Buffer[] = [];
      for (;;) {
        const n = fs.readSync(fd, buffer, 0, buffer.length, offset);
        if (n === 0) return chunks;
        offset += n;
        chunks.push(Buffer.from(buffer.subarray(0, n)));
      }
    },
    close(): void {
      fs.closeSync(fd);
    },
  };
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The argv a spec runs with, after binary resolution. */
export function specArgv(spec: CommandSpec, resolve: (bin: string) => string): [string, string[]] {
  const [bin, ...args] = spec.argv;
  return [resolve(bin), args];
}
