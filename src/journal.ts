import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';
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

const readAsync = promisify(fs.read);
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
  // A missing cwd makes spawn fail as "spawn /bin/sh ENOENT", naming the wrong path. Name the cwd.
  if (options.cwd !== undefined && !fs.statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Working directory does not exist: ${options.cwd}`);
  }
  fs.writeFileSync(file(dir, 'stdin'), options.stdin, { mode: 0o600 });
  fs.writeFileSync(file(dir, 'stdout'), '', { mode: 0o600 });
  fs.writeFileSync(file(dir, 'stderr'), '', { mode: 0o600 });
  const child = spawn('/bin/sh', ['-c', WRAPPER, 'agent-cli-journal', dir, bin, ...args], {
    cwd: options.cwd,
    detached: true,
    stdio: 'ignore',
    ...(options.env ? { env: options.env } : {}),
  });
  // Listen BEFORE the pid check: a failed spawn emits 'error' on the next tick, and the throw
  // below used to skip this line, so that 'error' went unhandled and killed the whole backend
  // with every live turn (2026-10-14, missing cwd). Guard: journal.test.ts "failed spawn".
  child.on('error', () => undefined);
  if (child.pid === undefined) throw new Error(`Could not start the execution wrapper for ${bin}`);
  fs.writeFileSync(file(dir, 'pid'), String(child.pid), { mode: 0o600 });
  // We just spawned it: identity is known, no `ps` needed (its start time fills in on first verify).
  identities.set(dir, { pid: child.pid, start: '', own: true });
  child.unref();
  return child.pid; // pid written in spawn's tick: no reader sees the process without it
}

export function executionProcess(dir: string): ExecutionProcess {
  const pid = readPid(dir);
  if (pid === null) return { t: 'unstarted' };
  return readExit(dir) === null && isOwnWrapper(pid, dir) ? { t: 'live', pid } : { t: 'ended' };
}

/** The wrapper (not just the CLI) is still running: exit.json lands before the wrapper exits. */
export function executionWrapperAlive(dir: string): boolean {
  const pid = readPid(dir);
  return pid !== null && isOwnWrapper(pid, dir);
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
  try {
    return parseExit((JSON.parse(fs.readFileSync(file(dir, 'exit.json'), 'utf8')) as { status: number }).status);
  } catch {
    return null;
  }
}

function parseExit(status: number): ExitStatus {
  if (status < 128) return { exitCode: status, signal: null };
  const name = Object.entries(constants.signals).find(([, n]) => n === status - 128)?.[0];
  return { exitCode: null, signal: (name as NodeJS.Signals | undefined) ?? null };
}

// Pattern: async-liveness (docs/patterns.md#async-liveness)
// Fix-guard (2026-10-23): isOwnWrapper used to execFileSync('ps') on every liveness check, which
// followJournal ran per second per execution and oompa per tick: 74% of the server main thread
// sat in SyncProcessRunner::Spawn. Identity (is this pid OUR wrapper, not a reused pid) is now
// established ONCE per execution and cached by pid + start time; liveness is process.kill(pid, 0).
// A cached identity is re-checked only by verifyExecutions (ONE async batched ps). Guard:
// journal.test.ts "liveness never spawns synchronously".
interface Identity {
  readonly pid: number;
  /** `ps lstart` of the wrapper; '' until the first verification when we spawned it ourselves. */
  start: string;
  /** Only ever cached as true (a "not ours" first sight can be a pre-exec fork; see isOwnWrapper). */
  own: boolean;
}
const identities = new Map<string, Identity>();
// Fix-guard (2026-10-23, oompa-poll was the #1 stall: 145 stalls, 35 s in 30 min): a live pid that
// is NOT our wrapper (a reused pid of an old execution) re-ran the sync `ps` on every check, every
// tick, forever, because only positive verdicts were cached. A stranger is now remembered for
// STRANGER_TTL_MS, keyed by pid. The TTL (not a permanent verdict) keeps the pre-exec fork race
// closed: spawners register their wrapper with trustSpawnedWrapper(), so a fresh fork is never a
// first sight. Guard: journal.test.ts "a reused pid is probed once, not every check".
const STRANGER_TTL_MS = 10_000;
const strangers = new Map<string, { pid: number; until: number }>();

const PS_ROW = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/;
function parsePs(output: string): Map<number, { start: string; command: string }> {
  const rows = new Map<number, { start: string; command: string }>();
  for (const line of output.split('\n')) {
    const m = PS_ROW.exec(line);
    if (m) rows.set(Number(m[1]), { start: m[2], command: m[3] });
  }
  return rows;
}
const psArgs = (pids: readonly number[]) => ['-o', 'pid=,lstart=,command=', '-p', pids.join(',')];

/** Alive AND still our wrapper: a reused pid runs a command line that never names this dir. */
function isOwnWrapper(pid: number, dir: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    identities.delete(dir);
    strangers.delete(dir);
    return false;
  }
  const known = identities.get(dir);
  if (known && known.pid === pid) return known.own;
  const stranger = strangers.get(dir);
  if (stranger && stranger.pid === pid && Date.now() < stranger.until) return false;
  // First sight of this pid for this dir (adoption after a restart): the one sync `ps`.
  let rows: ReturnType<typeof parsePs>;
  try {
    rows = parsePs(
      execFileSync('ps', psArgs([pid]), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    );
  } catch {
    rows = new Map();
  }
  const row = rows.get(pid);
  const own = row !== undefined && row.command.includes(dir);
  // Cache only a POSITIVE identity. A fresh fork still shows its parent's command line until exec,
  // so a first-sight "not ours" can be transient: caching it made oompa.ts treat a live run host
  // as ended and never signal it (oompa-mcp drain tests, 2026-10-23). A stranger just re-runs ps.
  if (own) {
    identities.set(dir, { pid, start: row.start, own });
    strangers.delete(dir);
  } else {
    identities.delete(dir);
    strangers.set(dir, { pid, until: Date.now() + STRANGER_TTL_MS });
  }
  return own;
}

/** A spawner that just forked `pid` as this dir's wrapper vouches for it: no `ps`, no fork race. */
export function trustSpawnedWrapper(dir: string, pid: number): void {
  strangers.delete(dir);
  identities.set(dir, { pid, start: '', own: true });
}

/**
 * Cache-only identity answer for async pollers: true only when this pid is already a verified own
 * wrapper. Never spawns, never touches the filesystem.
 */
export function isKnownOwnWrapper(dir: string, pid: number): boolean {
  const known = identities.get(dir);
  return known !== undefined && known.pid === pid && known.own;
}

/**
 * Re-verify every cached-own identity among `dirs` with ONE async `ps`: a pid that died and was
 * reused (different start time or command) stops being our wrapper. Never throws.
 */
export async function verifyExecutions(dirs: Iterable<string>): Promise<void> {
  const cached = [...new Set(dirs)].flatMap((dir) => {
    const id = identities.get(dir);
    return id?.own ? [{ dir, id }] : [];
  });
  if (cached.length === 0) return;
  const output = await new Promise<string>((resolve) =>
    execFile('ps', psArgs(cached.map((c) => c.id.pid)), { encoding: 'utf8' }, (_e, out) =>
      resolve(out ?? '')
    )
  );
  const rows = parsePs(output);
  for (const { dir, id } of cached) {
    if (identities.get(dir) !== id) continue;
    const row = rows.get(id.pid);
    if (row === undefined) continue; // dead: kill(pid, 0) reports it, and clears the entry
    if (!row.command.includes(dir) || (id.start !== '' && id.start !== row.start)) id.own = false;
    else id.start = row.start;
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
  const drain = async () => {
    for (const chunk of await stdout.read()) callbacks.onStdout(chunk);
    for (const chunk of await stderr.read()) callbacks.onStderr(chunk);
  };
  const exitStatus = async () => {
    try {
      return parseExit(JSON.parse(await fsp.readFile(file(dir, 'exit.json'), 'utf8')).status);
    } catch {
      return null;
    }
  };
  const settle = (t: number) => new Promise<void>((r) => setTimeout(r, t));
  // Async reads, 100 ms poll: the sync tail ran readSync + readFileSync 160x/s per execution on
  // the event loop. Liveness every 10 ticks (1 s) is process.kill(pid, 0) on a cached identity;
  // identity itself is re-verified every 30 s by one async `ps`.
  return (async () => {
    for (let ticks = 1; ; ticks++) {
      await drain();
      if (ticks % 300 === 0) await verifyExecutions([dir]);
      const live = ticks % 10 !== 0 || (pid !== null && isOwnWrapper(pid, dir));
      const status = await exitStatus();
      if (status === null && live) {
        await settle(100);
        continue;
      }
      await drain();
      stdout.close();
      stderr.close();
      return status ? { kind: 'exited' as const, status } : { kind: 'lost' as const };
    }
  })();
}

function openTail(path: string) {
  const fd = fs.openSync(path, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  return {
    async read(): Promise<Buffer[]> {
      const chunks: Buffer[] = [];
      for (;;) {
        const { bytesRead: n } = await readAsync(fd, buffer, 0, buffer.length, offset);
        if (n <= 0) return chunks;
        offset += n;
        chunks.push(Buffer.from(buffer.subarray(0, n)));
      }
    },
    close: () => fs.closeSync(fd),
  };
}
