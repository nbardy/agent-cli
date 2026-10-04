import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import type { HarnessName } from './types.ts';
import type { TurnMode } from './runtime-types.ts';

/**
 * A provider execution journaled on disk, so it outlives the process that started it. Output
 * goes to FILES, never pipes: a piped child dies of SIGPIPE once its reader exits (measured
 * 2026-08-21), a file-backed one runs to completion. Every reader, the spawner included, follows
 * the files from byte 0, so a later process adopts a live execution on the same path.
 *
 * Files: execution.json (before spawn), pid (= its group, in spawn's tick), stdin, stdout, stderr,
 * exit.json (the wrapper's `$?`, tmp + rename). The directory is the execution's one store: its
 * owner keeps its own state as further files here and reads the process only via executionProcess.
 * The wrapper is `sh` with `trap : TERM INT`: a group SIGTERM kills the CLI and the shell
 * survives to record the status. Only a SIGKILLed group leaves no exit.json (`lost`).
 * Design: unleashd agent_notes/2026-09-30_execution-adoption-design.md.
 */
export interface ExecutionRecord {
  readonly version: 1;
  readonly harness: HarnessName;
  readonly mode: TurnMode;
  readonly debugRawEvents: boolean;
  /** Known before spawn (resume/fork); '' when the CLI names one. */
  readonly sessionId: string;
  /** Harness temp config for this process only, removed once it is gone. */
  readonly ownedPaths: readonly string[];
  readonly startedAt: string;
}

/** The process behind a journal: the only view of it any reader keeps. */
export type ExecutionProcess = { t: 'unstarted' } | { t: 'live'; pid: number } | { t: 'ended' };

type ExitStatus = { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null };

const file = (dir: string, name: string) => path.join(dir, name);

// $1 = journal dir, the rest = argv. `: TERM INT` (not '') keeps the CLI's dispositions default.
const WRAPPER = `trap : TERM INT
d="$1"; shift
"$@" <"$d/stdin" >>"$d/stdout" 2>>"$d/stderr"
s=$?
printf '{"status":%d}\\n' "$s" >"$d/exit.tmp" && mv "$d/exit.tmp" "$d/exit.json"`;

export function writeExecutionRecord(dir: string, record: ExecutionRecord): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(dir, 'execution.tmp'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.renameSync(file(dir, 'execution.tmp'), file(dir, 'execution.json'));
}

export function readExecutionRecord(dir: string): ExecutionRecord {
  const record = JSON.parse(fs.readFileSync(file(dir, 'execution.json'), 'utf8')) as ExecutionRecord;
  if (record.version !== 1) throw new Error(`Unsupported execution journal version in ${dir}`);
  return record;
}

/** Spawn the wrapper detached (own session and group), stdio to files. */
export function spawnJournaled(
  dir: string,
  bin: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin: string }
): number {
  fs.writeFileSync(file(dir, 'stdin'), options.stdin, { mode: 0o600 });
  fs.writeFileSync(file(dir, 'stdout'), '', { mode: 0o600 });
  fs.writeFileSync(file(dir, 'stderr'), '', { mode: 0o600 });
  const child = spawn('/bin/sh', ['-c', WRAPPER, 'agent-cli-journal', dir, bin, ...args], {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
    ...(options.env ? { env: options.env } : {}),
  });
  if (child.pid === undefined) throw new Error(`Could not start the execution wrapper for ${bin}`);
  fs.writeFileSync(file(dir, 'pid'), String(child.pid), { mode: 0o600 });
  child.unref();
  child.on('error', () => undefined);
  return child.pid; // pid written in spawn's tick: no reader sees the process without it
}

export function executionProcess(dir: string): ExecutionProcess {
  const pid = readPid(dir);
  if (pid === null) return { t: 'unstarted' };
  return readExit(dir) === null && isOwnWrapper(pid, dir) ? { t: 'live', pid } : { t: 'ended' };
}

/** SIGTERM the group, then SIGKILL it after the grace if it is still our wrapper. */
export function killExecution(pid: number, dir: string, graceMs = 3000): void {
  signalOwnGroup(pid, dir, 'SIGTERM');
  setTimeout(() => signalOwnGroup(pid, dir, 'SIGKILL'), graceMs).unref();
}

export function readPid(dir: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(file(dir, 'pid'), 'utf8'), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readExit(dir: string): ExitStatus | null {
  let status: number;
  try {
    status = (JSON.parse(fs.readFileSync(file(dir, 'exit.json'), 'utf8')) as { status: number }).status;
  } catch {
    return null;
  }
  if (status < 128) return { exitCode: status, signal: null };
  const name = Object.entries(constants.signals).find(([, n]) => n === status - 128)?.[0];
  return { exitCode: null, signal: (name as NodeJS.Signals | undefined) ?? null };
}

/** Alive AND still our wrapper: a reused pid runs a command line that never names this dir. */
function isOwnWrapper(pid: number, dir: string): boolean {
  try {
    process.kill(pid, 0);
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).includes(dir);
  } catch {
    return false;
  }
}

/** Signal the group only while the pid is still our wrapper (review of P1, 2026-10-01). */
export function signalOwnGroup(pid: number, dir: string, signal: NodeJS.Signals): void {
  if (!isOwnWrapper(pid, dir)) return;
  try {
    process.kill(-pid, signal);
  } catch {}
}

/**
 * Deliver the journal's output in order from byte 0, then resolve once the execution ended and
 * every byte written before that was delivered; `lost` when the wrapper died without exit.json.
 */
export function followJournal(
  dir: string,
  callbacks: { onStdout(chunk: Buffer): void; onStderr(chunk: Buffer): void }
): Promise<{ kind: 'exited'; status: ExitStatus } | { kind: 'lost' }> {
  const stdout = openTail(file(dir, 'stdout'));
  const stderr = openTail(file(dir, 'stderr'));
  const pid = readPid(dir);
  const drain = () => {
    for (const chunk of stdout.read()) callbacks.onStdout(chunk);
    for (const chunk of stderr.read()) callbacks.onStderr(chunk);
  };
  return new Promise((resolve) => {
    let ticks = 0;
    const tick = () => {
      drain();
      // Liveness every 20 ticks (1 s); exit.json re-read after it, as it may land in between.
      const live = ++ticks % 20 !== 0 || (pid !== null && isOwnWrapper(pid, dir));
      const status = readExit(dir);
      if (status === null && live) return void setTimeout(tick, 50);
      drain();
      stdout.close();
      stderr.close();
      resolve(status ? { kind: 'exited', status } : { kind: 'lost' });
    };
    tick();
  });
}

function openTail(path: string) {
  const fd = fs.openSync(path, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  return {
    read(): Buffer[] {
      const chunks: Buffer[] = [];
      for (let n = fs.readSync(fd, buffer, 0, buffer.length, offset); n > 0; ) {
        offset += n;
        chunks.push(Buffer.from(buffer.subarray(0, n)));
        n = fs.readSync(fd, buffer, 0, buffer.length, offset);
      }
      return chunks;
    },
    close: () => fs.closeSync(fd),
  };
}
