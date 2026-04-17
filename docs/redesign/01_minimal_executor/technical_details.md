# Minimal Executor Technical Details

This document turns the redesign into concrete module boundaries and migration
steps. It stays intentionally narrow: the submodule should be a thin input and
output wrapper, not a runtime platform.

## Current files to anchor the redesign

The redesign is grounded in these existing files:

- `src/types.ts`
- `src/build.ts`
- `src/run.ts`
- `src/fork-emulation.ts`
- `src/harnesses/*`

Those files already show the right conceptual split:

- `types.ts` defines the canonical vocabulary
- `build.ts` is the pure command builder
- `harnesses/*` describe CLI syntax
- `fork-emulation.ts` is a special-case session helper
- `run.ts` is where the boundaries collapsed

The redesign should preserve the first four and dismantle the last one into
smaller responsibilities.

## Proposed module layout

The package should end up with a layout like this:

```text
src/
  types.ts
  build.ts
  resolve.ts
  run.ts
  execute.ts
  session.ts
  heartbeat.ts
  parsers/
    index.ts
    shared.ts
    claude.ts
    codex.ts
    gemini.ts
    opencode.ts
    cursor.ts
  harnesses/
    index.ts
    claude.ts
    codex.ts
    gemini.ts
    opencode.ts
    cursor.ts
  fork-emulation.ts
  cli.ts
  index.ts
```

The important part is not the exact filenames. The important part is the
responsibility boundary:

- `build.ts` = argv synthesis
- `execute.ts` = process lifecycle
- `parsers/*` = raw output normalization
- `session.ts` = session id and fork/resume helpers
- `heartbeat.ts` = silence detection / liveness hints
- `run.ts` = compatibility facade only

## Public API

The public API should be smaller than the current one.

### Keep as public

- `buildCommand`
- `executeCommand`
- `getHarness`
- `listHarnesses`
- `resolveBinary`
- the canonical types from `types.ts`

### Keep only as compatibility, then deprecate

- `runCommand`
- `executeTurn`

The package should not encourage multiple ways to do the same thing. The
direction is one execution primitive and one build primitive.

## Canonical request shape

The submodule should keep one canonical request shape for execution. The shape
should be able to express everything the wrapper needs without introducing a
second semantic layer.

At minimum, the request needs fields like:

- `harness`
- `prompt`
- `cwd`
- `model`
- `sessionId`
- `resumeSessionId`
- `forkSessionId`
- `mode` if the harness actually needs it
- `yolo`
- `debugRawEvents`
- `detached`
- `reasoningEffort` or equivalent harness-specific effort field where needed
- `extraArgs`

The important constraint is that the request remains canonical. Build-only and
run-only variants should be projections of this request, not new concepts.

## Unified output event stream

The output stream should remain a single finite event union.

Recommended event types:

- `session.started`
- `turn.started`
- `text.delta`
- `tool.use`
- `progress`
- `stderr`
- `error`
- `out_of_tokens`
- `turn.complete`

### Event semantics

#### `session.started`

Emitted when the parser learns the provider session/thread id. The executor
should resolve `handle.sessionId` from the same source.

#### `turn.started`

Emitted once per turn when the harness indicates that a response cycle has
started.

#### `text.delta`

Emitted for assistant text content that can be streamed incrementally.

#### `tool.use`

Emitted when the harness reports a tool call or equivalent structured action.
The event should carry normalized fields:

- tool name
- input payload
- optional display text

No additional product semantics should be attached here.

#### `progress`

Use this sparingly. Only emit it when the harness provides a real machine-
readable progress signal. Do not use it as a dumping ground for anything that is
awkward to classify.

#### `stderr`

Raw stderr stays raw. It may be mirrored to the terminal in debug mode, but it
should remain a distinct stream event.

#### `error`

Used when the wrapper can determine the turn has failed in a non-terminal way or
when the harness reports a structured fatal error.

#### `out_of_tokens`

Keep this as a narrow classification for token/quota exhaustion. It is a
completion classification, not a product-level state machine.

#### `turn.complete`

The parser or executor emits this once the turn is done and the final reason is
known.

## Generic executor responsibilities

`src/execute.ts` should own the mechanics that do not depend on a specific
harness.

### The executor should:

1. resolve the harness config
2. build the argv via `buildCommand`
3. spawn the child process
4. wire stdin according to config
5. split stdout into records according to stdout mode
6. pass records to the selected parser
7. publish normalized events through an async queue
8. capture the final completion reason and exit code
9. resolve the final session id promise

### The executor should not:

- parse provider JSON schemas itself
- infer app-level concepts like conversations or workers
- know about merge/swarm/review workflows
- know about UI state
- mutate any persistent domain model

The executor is a process driver. Nothing more.

## Parser contract

Each parser module should implement the same small shape.

Example:

```ts
export interface HarnessParser {
  readonly stdout: 'jsonl' | 'text' | 'ignore';
  init(ctx: ParserContext): ParserState;
  pushLine(line: string, state: ParserState, ctx: ParserContext): UnifiedAgentEvent[];
  finish(state: ParserState, ctx: ParserContext): UnifiedAgentEvent[];
}
```

### Parser context

The parser context should be minimal:

- harness name
- canonical request
- maybe the resolved argv spec
- maybe a debug flag

The parser should not reach into the executor. It should not have a child
process handle. It should not know about the caller application.

### Parser state

Parser state is local to one execution. It can track things like:

- whether `turn.started` has already been emitted
- the current session id
- whether a terminal result has been seen
- buffered partial text
- harness-specific line accumulation

That state should die with the run.

## Harness-specific parsing guidance

The current harnesses already demonstrate that the syntax differences are small.
The parser modules should preserve that property.

### Claude

Claude parsing should translate JSONL into the unified events and nothing else.
It should interpret init/session records, assistant text, tool calls, and final
result records. It should not encode Claude-specific session semantics outside
the parser.

### Codex

Codex parsing should normalize all structured records into the same stream as
the other harnesses. If Codex emits collaborative tool calls, they should be
surfaced as `tool.use` events with the raw input payload preserved.

The parser should not create a special subagent model. It should not invent a
conversation graph. It should not interpret collaboration output as product
state. It is just normalized tool output.

### Gemini

Gemini parsing should remain a small adapter that handles JSONL plus any text
fallbacks required by the CLI. Interactive auth detection belongs here or in a
shared helper, not in the executor.

### OpenCode and Cursor

These parsers should remain thin. They should only encode the handful of output
shapes those harnesses actually produce.

## Session and fork handling

Session handling should be a separate step from parsing.

### Session id resolution

The executor should resolve session ids from parser output and expose them
through:

- `handle.sessionId`
- `handle.completed.sessionId`
- `session.started`

That keeps the caller from having to guess whether the session id came from
input, init output, or a resumed turn.

### Resume

Resume should be a direct mapping from canonical request to harness syntax.
Resume should not imply any application-level recovery logic.

### Fork

Fork emulation should be kept as an explicit helper if a harness genuinely has
no native non-interactive fork. The helper should copy the session artifact and
return the new session id for the executor to resume.

The key cleanup here is removing fork mutation from the harness config object.
The config should describe syntax. It should not mutate the filesystem.

## Heartbeat behavior

The current package has timeout and silence logic mixed into the main runtime.
That should be separated.

If the package still needs heartbeat behavior, it should live in `heartbeat.ts`
as a generic utility:

- observe elapsed silence
- emit a generic progress hint or timeout signal
- never classify a provider

Heartbeat should not know how Codex differs from Claude. It should only know
that a process has been quiet for too long.

## `src/harnesses/*`

The harness registry should remain pure data plus small pure formatting hooks.

### Keep there

- binary name
- base command
- bypass flags
- prompt delivery mode
- stdin/stdout mode
- cwd flag
- model formatting hooks
- session flag formatting hooks if they are pure string builders

### Remove from there

- filesystem mutation
- session file copying
- process execution
- output parsing

If a harness cannot be described without side effects in config, the side
effects belong elsewhere.

## `src/fork-emulation.ts`

This file can stay, but its role should narrow.

It should be a low-level utility that does one job:

- find a session artifact
- copy it to a new id
- rewrite any embedded session metadata required to keep the copy valid
- return the new id and file path information

That is it.

It should not be invoked from random places. The executor should call it only
when a request explicitly asks for a fork and the selected harness has no native
fork support.

## `src/run.ts`

`run.ts` should be reduced to a facade layer.

The end state should be:

- export the public API
- delegate to `execute.ts`
- keep compatibility shims for old names during migration
- avoid containing any substantial parsing or process logic

If `run.ts` still contains provider-specific branches after the refactor, the
redesign has not gone far enough.

## `src/index.ts`

The entrypoint should only re-export the minimal public surface.

Recommended exports:

- `buildCommand`
- `executeCommand`
- `getHarness`
- `listHarnesses`
- `resolveBinary`
- the canonical types

Recommended temporary compatibility exports:

- `runCommand`
- `executeTurn`

Those should be treated as transition helpers, not new architecture.

## Test organization

Tests should mirror the new boundaries and stay lean.

### 1. Contract tests

Contract tests should live under a clear contract-oriented directory, or at
least be organized that way within the existing `test/` folder.

Examples:

- `buildCommand` argv snapshots
- parser fixtures for each harness
- executor lifecycle against tiny fake binaries

These tests should use deterministic local shims. They should not require real
vendor sign-in unless they are explicitly live tests.

### 2. Live tests

Live tests should run against real harnesses only when opt-in env vars are set.

They should validate:

- the package can start a real harness
- the event stream is still normalized enough for consumers
- resume works against a real session id
- known edge cases still behave after refactors

Keep live tests narrow. They should catch integration drift, not replace the
contract suite.

### 3. Manual tests

Manual tests belong in `manual_tests/`.

They should include:

- scripts that run real harness captures
- readme notes on how to reproduce probes
- captured logs under a run directory

They are not part of automated verification. Their value is in inspecting
unstable or surprising output when the harness APIs change.

## Migration path

The safest migration path is incremental and compatibility-first.

### Phase 1: extract parser modules

Move provider-specific parsing out of `run.ts` into `src/parsers/*`.

Keep the external behavior the same. Add contract tests around the extracted
parsers before deleting the old inline logic.

### Phase 2: extract the generic executor

Move spawn and lifecycle management into `src/execute.ts`.

`run.ts` becomes a delegating facade. This step should not change the public
event stream.

### Phase 3: move session/fork helpers out of config

Remove filesystem mutation from `HarnessConfig`. Call the helper explicitly from
the executor path instead.

This is the cleanup that restores the config layer to pure syntax data.

### Phase 4: trim the public surface

Once callers are on the new executor path, deprecate or internalize duplicated
exports such as `executeTurn`.

The goal is a small API, not a large compatibility layer.

### Phase 5: delete dead code

After the contract and live tests cover the new path, remove the old inline
helpers from `run.ts`.

## What success looks like

The final package should feel simple in three ways:

1. A caller can describe a turn with one request object.
2. A caller can consume one event stream without knowing harness internals.
3. The codebase makes it hard to put product semantics into the submodule by
   accident.

If a new change makes the package more stateful, more branch-heavy, or more
aware of consumer-app concepts, that is a regression against this redesign.
