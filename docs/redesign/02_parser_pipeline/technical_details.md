# Parser Pipeline Technical Details

## Current Files That Matter

This redesign is grounded in the files that already exist:

- `src/types.ts`
- `src/build.ts`
- `src/run.ts`
- `src/fork-emulation.ts`
- `src/harnesses/index.ts`
- `src/harnesses/claude.ts`
- `src/harnesses/codex.ts`
- `src/harnesses/gemini.ts`
- `src/harnesses/opencode.ts`
- `src/harnesses/cursor.ts`

The current package already has the right macro boundaries. The issue is that `run.ts` has become a collector for all remaining behavior.

## Exact Public API

Downstream consumers should use the smallest practical API.

### Main entry points

```ts
import {
  buildCommand,
  runCommand,
  resolveBinary,
  getHarness,
  listHarnesses,
} from '@nbardy/agent-cli';
```

### Main types

```ts
import type {
  Harness,
  HarnessName,
  BuildOptions,
  CommandSpec,
  RunOptions,
  RunResult,
  UnifiedAgentEvent,
} from '@nbardy/agent-cli';
```

### Preferred usage

Use `buildCommand` when you only need argv construction.

Use `runCommand` when you want the full thin wrapper:

- spawn a harness
- receive normalized events
- stop the process
- observe the final session id and completion result

### Compatibility surface

`executeCommand` and `executeTurn` should remain aliases for migration only.

They are useful for compatibility, but they should not be the documented target shape.

## Suggested Internal Layout

The internal layout should be direct and small.

### Compiler

- `src/build.ts`

This file should remain the sole owner of CLI syntax generation.

### Runtime coordinator

- `src/run.ts`

This file should only:

- resolve the harness
- compile the command
- spawn the process
- wire the parser pipeline
- expose the execution handle

### Process layer

- `src/pipeline/process.ts`

Responsibilities:

- wrap `child_process.spawn`
- connect stdio
- surface `exitCode`
- propagate stop/cancel

This layer should not understand provider event shapes.

### Line decoder

- `src/pipeline/line-decoder.ts`

Responsibilities:

- buffer partial chunks
- split on newline
- preserve incomplete trailing fragments
- keep byte-to-line conversion isolated from parsing

This layer should not parse JSON.

### JSON parser

- `src/pipeline/json-parser.ts`

Responsibilities:

- trim and parse a line
- return either a parsed object or a raw-line failure
- keep malformed data visible enough for diagnostics

This layer should not know which harness produced the line.

### Harness parser

- `src/pipeline/harness-parser.ts`
- `src/parsers/*.ts`

Responsibilities:

- interpret parsed JSON objects for a specific harness
- emit normalized events
- own harness-specific state

This is where Claude’s stateful behavior belongs.

### Session binder

- `src/pipeline/session-binder.ts`

Responsibilities:

- extract session ids from parsed objects
- bind `session.started` once
- preserve initial vs resolved session id
- handle resume/fork indirection

The binder should not translate tool events.

### Completion synthesizer

- `src/pipeline/completion-synthesizer.ts`

Responsibilities:

- decide the final completion reason
- handle explicit `turn.complete`
- handle silent process exit
- handle cancellation
- handle parse failures that occur after useful output started

This logic is runtime policy, not parser policy.

### Fork emulation

- `src/fork-emulation.ts`

Responsibilities:

- emulate a fork only when the harness lacks a native non-interactive fork flag
- rewrite the on-disk session copy
- return the new session id

This stays separate from parser code because it is a filesystem/session concern, not an output concern.

## Parser Pipeline Contract

The cleanest model is a small sequence of functions, each with plain input and plain output.

### Stage 1: command compilation

Input:

- harness
- options

Output:

- `CommandSpec`

Current source of truth:

- `buildCommand` in `src/build.ts`

### Stage 2: process execution

Input:

- `CommandSpec`
- process settings

Output:

- child process handle
- stdout chunks
- stderr chunks
- exit status

### Stage 3: line decoding

Input:

- raw stdout/stderr chunks

Output:

- complete lines
- trailing fragment state

### Stage 4: JSON parsing

Input:

- one decoded line

Output:

- parsed object
- or a raw diagnostic event

### Stage 5: harness parsing

Input:

- parsed object
- parser state
- harness name

Output:

- zero or more `UnifiedAgentEvent`s
- updated parser state

### Stage 6: session binding

Input:

- parsed object
- current session state

Output:

- `session.started` when appropriate
- session id updates

### Stage 7: completion synthesis

Input:

- exit state
- parser state
- whether a terminal event was seen
- whether meaningful content was seen

Output:

- final `turn.complete`
- diagnostics if the process ended incorrectly

## How Stateful Parsers Should Work

Claude is the main reason this architecture needs a parser instance rather than a flat pure function.

The rule should be:

- parser state is local to the harness parser module
- `run.ts` owns exactly one parser instance per execution
- parser state does not leak into the rest of the package
- parser state should only affect normalized output, never process control

That means `run.ts` can remain a coordinator even when a parser needs to remember prior lines.

### Good shape

```ts
const parser = createHarnessParser(harness);
for (const line of lines) {
  const parsed = parseJsonLine(line);
  for (const event of parser.push(parsed)) emit(event);
}
```

### Bad shape

```ts
if (harness === 'claude') {
  // a hundred lines of special cases in run.ts
}
```

The difference is not cosmetic. The first keeps future drift contained. The second recreates the current problem.

## What `run.ts` Should Keep

The following behavior is necessary and should remain in the runtime layer:

- launching the child process
- respecting `detached`
- stopping the process cleanly
- binding stdin behavior from `CommandSpec`
- collecting stdout and stderr
- emitting `session.started`
- emitting `turn.started`
- emitting `turn.complete`
- tracking cancellation and exit code
- handling late flushes at process exit
- surfacing visible diagnostics when the harness ends without a terminal event

These are runtime concerns, not parser concerns.

## What `run.ts` Should Lose

The following behavior is accidental coupling and should move out:

- harness-specific JSON parsing branches
- direct knowledge of per-harness event shapes
- stateful parser bookkeeping inline in stdout handlers
- special-case completion logic scattered across provider branches
- session extraction mixed into buffering logic
- parser fallback logic buried in process exit code paths

The runner should not have to know the semantics of a Claude event, a Codex chunk, or a Gemini JSON shape.

## Harness-Specific Parser Responsibilities

Each parser should do just enough to normalize its own CLI.

### Claude

Likely responsibilities:

- stitch multi-step event objects into normalized `text.delta`, `tool.use`, and `turn.complete`
- preserve state across related lines
- recognize interactive phases without entangling runtime control

### Codex

Likely responsibilities:

- parse JSONL into normalized events
- capture session ids
- normalize tool and progress events
- keep execution semantics separate from formatting semantics

### Gemini

Likely responsibilities:

- parse the provider’s JSONL stream
- normalize session ids and terminal events
- preserve resume semantics

### OpenCode

Likely responsibilities:

- normalize its stream format into the shared event set

### Cursor

Likely responsibilities:

- handle noisy preamble and ANSI content
- recover the event stream from its JSON output format

The important point is that these modules should not become mini-runtimes. They are parsers, not orchestrators.

## Proposed Event Contract

The output stream should remain boring and uniform.

The package should only promise a small normalized set:

- `session.started`
- `turn.started`
- `text.delta`
- `tool.use`
- `progress`
- `stderr`
- `error`
- `turn.complete`

That is the correct boundary for a thin wrapper.

Do not add more event families unless a downstream consumer truly cannot express its needs with these primitives.

## Tests

Testing should match the architecture.

### Pure parser tests

These should live beside parser modules and cover:

- line-to-event normalization
- stateful parser stitching
- malformed JSON handling
- session-id extraction from parsed objects
- terminal event normalization

They should not spawn processes.

### Executor tests

These should cover the thin runtime pipeline:

- spawn options
- stdout chunk decoding
- stderr forwarding
- session binding
- completion synthesis
- cancellation

These tests should assert that the coordinator wires the stages together correctly.

### Live/manual probes

These should remain explicit probes, not CI fixtures.

They are the place to observe:

- CLI output drift
- session-file changes
- hidden parser regressions
- behavior differences between real provider binaries and mocked fixtures

The submodule already has the right place for these probes: manual test scripts and captured logs. They should stay out of the core unit-test surface.

## Migration Plan

The migration should be staged so that callers do not feel churn.

### Step 1: Preserve the export surface

Keep the current public exports working while internals move.

### Step 2: Extract parser modules

Move per-harness parsing out of `run.ts`.

Claude should be the first parser to move because it is the strongest proof that stateful parsing does not belong in the runner.

### Step 3: Add the runtime pipeline helpers

Introduce tiny helpers for:

- line decoding
- JSON parsing
- session binding
- completion synthesis

### Step 4: Reduce `run.ts` to orchestration

Once the helpers exist, `run.ts` should mostly become:

- setup
- wire stages together
- stream events
- finalize

### Step 5: Delete dead branches

Remove the old inline logic only after the new pipeline is proven with tests.

### Step 6: Tighten the documented API

The docs and README should point downstreams toward `buildCommand` and `runCommand` as the stable entry points.

## Non-Goals

This redesign should not try to become:

- a plugin system
- a framework for arbitrary event transforms
- a general-purpose process orchestration library
- a class-based runtime tree

Those are all larger than the problem.

The package should remain a thin wrapper that compiles a request into a command, runs a process, and normalizes the output.

## Final Shape

If this redesign is done well, the package should read like this:

- `types.ts` defines the contract
- `build.ts` compiles the command
- `run.ts` coordinates the process
- `parsers/*` translate harness output
- `fork-emulation.ts` handles the rare filesystem copy case
- tests prove each layer independently

That is the thin unified input/output wrapper you wanted, with stateful parsing kept in small harness-local seams instead of leaking into the whole package.

