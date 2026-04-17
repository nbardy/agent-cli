# Parser Pipeline Redesign

## Goal

Restore the original shape of `shared agent cli`: a thin wrapper that accepts a unified input shape, starts the right harness, and emits a unified output stream.

The package should stay narrow:

- one compiler for CLI arguments
- one process runner
- one parser pipeline
- one normalized event stream

No framework layer. No class hierarchy. No “runtime” abstraction with its own lifecycle semantics. The package should feel like a small set of pure functions plus a thin execution coordinator.

## Current Diagnosis

The current package still has a good core:

- `src/types.ts` defines the harness syntax data model.
- `src/build.ts` compiles a request into a command spec.
- `src/harnesses/*` holds the per-CLI configuration.
- `src/fork-emulation.ts` isolates the filesystem copy step for harnesses without native fork support.

The drift is in `src/run.ts`.

`run.ts` currently mixes:

- process spawn
- stdout/stderr buffering
- newline splitting
- JSON parsing
- provider-specific event translation
- session-id capture
- stateful parser behavior
- completion synthesis
- heartbeat/progress emission
- fork/resume glue
- backward-compatibility behavior

That is why the package feels heavier than the original “thin wrapper” idea. The problem is not that the package has a parser. The problem is that the parser and the runner are fused together.

## Design Principle

Keep the hard boundary simple:

- **Input**: a unified request object for all harnesses
- **Output**: a unified event stream for all harnesses

Everything else is implementation detail.

The pipeline should be explicit, linear, and boring:

1. compile command
2. start process
3. decode lines
4. parse JSON
5. parse harness events
6. bind session state
7. synthesize completion

Each stage should do one job and expose a tiny surface to the next stage.

## Proposed Architecture

### 1) Command compilation stays isolated

`src/build.ts` remains the only place that knows how to turn a harness plus options into an argv array.

It is allowed to know:

- harness-specific flag syntax
- resume/fork flag placement
- model decomposition
- reasoning flags
- prompt delivery mode

It is not allowed to know:

- stdout formats
- JSON event shapes
- parser state
- process lifecycle
- completion policy

### 2) Runner stays thin

`src/run.ts` should become a coordinator, not the place where behavior accumulates.

It should:

- call `buildCommand`
- spawn the child process
- wire stdout and stderr into the pipeline
- expose `events`, `completed`, `stop`, and `sessionId`
- manage shutdown, exit codes, and cancellation

It should not contain large provider-specific branches.

### 3) Parser pipeline is first-class

The parser pipeline should be decomposed into small stages with narrow contracts:

- `line decoder`
  - turns raw byte chunks into complete lines
  - keeps partial line buffering only
- `JSON parser`
  - parses a trimmed line into an object
  - returns raw-line fallback when the line is not JSON
- `harness parser`
  - converts a decoded JSON object into normalized events
  - owns harness-specific state
- `session binder`
  - extracts or updates the session id
  - handles resume/fork session mapping
- `completion synthesizer`
  - decides the terminal `turn.complete` reason
  - handles explicit terminal events, silent exits, killed processes, and parse failures

This is the right place to hold stateful parser behavior for Claude or any other harness with event spans that cross multiple JSON objects.

### 4) Stateful parsers live in parser modules, not in run.ts

Some harnesses do not emit fully independent event objects. Claude is the obvious case: its output can require state across several JSON lines before a user-facing event is complete.

The fix is not more conditionals in `run.ts`.

The fix is a parser instance per harness:

- parser module owns its state
- parser module exposes a small factory
- `run.ts` holds only the current parser instance
- the parser returns normalized events, not partial app logic

That keeps state local without making the package feel object-oriented.

### 5) Fork emulation stays separate

`src/fork-emulation.ts` is legitimate, but it is not parser logic.

It belongs in the session-boundary side of the package, because it performs filesystem work to fabricate a forkable session id for harnesses that do not support one natively.

That code should stay isolated from the parser pipeline.

## What the Public API Should Be

Downstream packages should use only the small public surface.

### Preferred API

1. `buildCommand(harness, options)`
   - returns the command spec only
   - use this when a caller wants argv without process execution

2. `runCommand(harness, options)`
   - starts the process and returns the execution handle
   - use this for normal integration

### Compatibility API

`executeCommand` and `executeTurn` can remain as aliases while callers migrate, but they should not be treated as the canonical surface.

The package should present one clear shape, not a stack of names for the same concept.

### What callers should rely on

Downstream code should depend on:

- `buildCommand`
- `runCommand`
- `Harness` / `HarnessName`
- `BuildOptions`
- `CommandSpec`
- `RunOptions`
- `RunResult`
- `UnifiedAgentEvent`

Downstream code should not depend on internal parser stages or provider-specific event internals.

## Exact Module Layout

This redesign should keep the current top-level files and add only a few small seams.

### Keep

- `src/types.ts`
- `src/build.ts`
- `src/fork-emulation.ts`
- `src/harnesses/index.ts`
- `src/harnesses/claude.ts`
- `src/harnesses/codex.ts`
- `src/harnesses/opencode.ts`
- `src/harnesses/gemini.ts`
- `src/harnesses/cursor.ts`

### Thin coordinator

- `src/run.ts`

### Parser pipeline

- `src/pipeline/line-decoder.ts`
- `src/pipeline/json-parser.ts`
- `src/pipeline/harness-parser.ts`
- `src/pipeline/session-binder.ts`
- `src/pipeline/completion-synthesizer.ts`

### Harness parsers

- `src/parsers/claude.ts`
- `src/parsers/codex.ts`
- `src/parsers/opencode.ts`
- `src/parsers/gemini.ts`
- `src/parsers/cursor.ts`

### Optional support utilities

- `src/pipeline/heartbeat.ts`
- `src/pipeline/stderr.ts`
- `src/pipeline/process.ts`

The key constraint is that these helpers should stay tiny. If one of them starts to feel like a subsystem, it is too big.

## What Is Necessary vs Accidental in `run.ts`

### Necessary

- spawning the child process
- wiring stdout and stderr
- deciding when stdin closes, stays open, or receives the prompt
- tracking cancellation and process exit
- emitting `session.started`
- emitting `turn.started`
- emitting `turn.complete`
- resolving the final session id
- handling late JSON flushes at process exit
- managing heartbeat/progress if the provider needs it for idle watchdog survival

### Accidental

- provider-specific parsing rules inline in the runner
- special cases for individual JSON event shapes
- state machines hidden inside stdout handlers
- duplicated completion logic across harness branches
- session-binding logic mixed with raw-line buffering
- parser fallback behavior tied to process exit handling

The rule is simple: if it varies by harness, it belongs in a parser module. If it varies by process lifecycle, it belongs in the runner or completion synthesizer. If it varies by session identity, it belongs in the session binder.

## Tests

Tests should be layered by cost and fidelity.

### 1) Pure parser tests

These are the most valuable tests.

They should cover:

- one file per harness parser
- stateful event stitching
- completion event extraction
- session id capture from parsed JSON
- fallback behavior for unknown or malformed JSON

These tests should run fast and should not spawn real CLIs.

### 2) Executor tests

These test the thin runtime boundary:

- spawn and shutdown behavior
- line splitting
- stderr emission
- session binding
- completion synthesis
- heartbeat behavior
- resume/fork path selection

These tests can use stubbed processes or fixture-driven harness output, but they should still exercise the runtime coordinator instead of mocking every branch individually.

### 3) Live probes

These are not unit tests.

They should be manual or opt-in scripts that run against real `claude`, `codex`, `gemini`, `opencode`, or `cursor` binaries and capture outputs for drift analysis.

Their job is to reveal changes in real harness behavior that unit tests will never catch, not to be a stable CI contract.

## Migration Plan

The migration should be incremental and low risk.

### Phase 1: Freeze the public surface

Keep the current exports working.

Do not force downstream callers to change first. The package should keep shipping while the internals are rearranged.

### Phase 2: Extract parser modules

Move provider-specific parsing logic out of `run.ts` into `src/parsers/*`.

This is the biggest simplification win. Once parsers are isolated, `run.ts` stops being the place where provider quirks accumulate.

### Phase 3: Split the runtime pipeline

Carve the runtime into:

- process execution
- line decoding
- JSON parsing
- session binding
- completion synthesis

Each stage should accept plain data and return plain data.

### Phase 4: Reduce `run.ts`

At this point `run.ts` should mostly wire stages together.

If a new feature wants to add logic directly to `run.ts`, it should have to justify why it does not belong in the pipeline.

### Phase 5: Remove back-compat clutter

Once downstreams are on the preferred API, `executeCommand` / `executeTurn` can be demoted further or removed if there is no remaining need.

## Bottom Line

The best redesign is not “more abstraction.”

It is:

- keep the unified input/output contract
- keep the command compiler pure
- move parser state out of the runner
- keep session behavior separate from parsing
- keep completion synthesis separate from transport
- keep the package small enough that a new harness does not force a rewrite of the whole file

