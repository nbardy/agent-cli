# Minimal Executor Redesign

This redesign restores the original shape of the package: a thin wrapper around
CLI harnesses with one unified input request and one unified output stream.

The submodule should not know about app/product concepts. It should not invent
conversation state, merge orchestration, swarm topology, child-worker models, or
anything else that only exists in the consumer application. The package exists
to do two things:

1. turn a canonical request into CLI argv
2. turn raw CLI output into a normalized event stream

Everything else is implementation detail.

## Target shape

The target is a very small public surface:

- `buildCommand(...)` for pure request -> argv translation
- `executeCommand(...)` for request -> running process -> unified events
- the canonical types in `src/types.ts`
- harness registry helpers such as `getHarness(...)` and `listHarnesses(...)`

That is enough for both CLI and library use. Anything else should be internal,
temporary, or deprecated.

## What is wrong with the current shape

The current `src/run.ts` has become the place where too many concerns meet:

- process spawning
- stdout/stderr collection
- line buffering
- JSON parsing
- session-id extraction
- resume/fork handling
- provider-specific completion logic
- auth prompt detection
- timeout / heartbeat behavior
- compatibility glue for several harnesses

That is why the file feels like a monolith. The problem is not that the package
has a shared CLI wrapper. The problem is that the wrapper owns too much runtime
state and too many provider-specific decisions.

The current structure also leaks behavior into the harness config layer. That is
fine for pure formatting helpers. It is not fine for filesystem mutation or
session-copy behavior living inside config objects.

## Principles

### 1. One request shape

The package should expose one canonical request type for execution. A caller
should not need a separate semantic model for build vs run. Build-only helpers
may project a subset of that request, but there should be one source of truth.

### 2. One event stream

The output contract should remain a single append-only event stream with a small
finite set of event types. The wrapper should not produce product-specific data
models. It should only emit normalized runtime facts such as:

- session started
- turn started
- text delta
- tool use
- progress
- stderr
- error
- turn complete

### 3. Thin harness wrappers

Each harness wrapper should do the minimum needed to map canonical request
fields to argv syntax and raw output to normalized events. A harness wrapper is
not a runtime system.

### 4. No app semantics

The submodule should not know what a conversation is in the consumer app. It
should not know what a merge workflow is. It should not know what a swarm is.
If a harness emits child-agent tool calls, the parser can normalize them as tool
events, but that is still harness output, not an application object model.

### 5. Prefer deletion over abstraction

If a concern cannot be expressed without special cases all over `run.ts`, the
right answer is usually to move it out of the core executor rather than layer on
another helper in the same file.

## Proposed architecture

The package should be split into four small responsibilities:

### 1. Command builder

`src/build.ts` stays the pure request-to-argv builder.

It should continue to read harness config and produce deterministic argv. This is
the cleanest part of the package and it should remain simple.

### 2. Generic executor

`src/run.ts` should stop being the place where all behavior lives. It should
become a thin facade around a generic executor module.

The generic executor is responsible for:

- spawning the child process
- wiring stdin/stdout/stderr
- buffering chunks into lines
- feeding complete records to a parser
- streaming normalized events to the caller
- resolving the final session id
- resolving completion reason and exit code

It should not know provider-specific parsing details.

### 3. Per-harness parsers

Each harness gets a tiny parser module that turns raw output into normalized
events. The parser owns all provider-specific output shapes.

Examples:

- Claude JSONL -> `session.started`, `text.delta`, `tool.use`, `turn.complete`
- Codex JSONL -> the same unified events, including `tool.use` for collab tool
  calls
- Gemini JSONL/text -> the same unified events, plus auth-prompt detection as
  a parser-local diagnostic
- OpenCode/Cursor -> the same unified events, with their own small syntax
  differences hidden inside the parser

The parser should not spawn processes. It should not read the filesystem. It
should not decide process exit policy. It should only interpret output.

### 4. Session and fork helpers

Session resolution and fork emulation should be separate from parsing.

If the package keeps fork emulation for harnesses that need copy-and-resume, it
should be an explicit helper used by the executor before spawn. It should not
live inside harness config as a hidden capability.

## What to keep

### Keep `src/types.ts`

This is where the canonical input and config vocabulary belongs. It is already
the right home for:

- supported harness names
- prompt delivery modes
- stdin/stdout behavior
- build options
- command spec

This file should stay small and descriptive. It should not grow into a second
runtime.

### Keep `src/build.ts`

This file already expresses the right idea: config data in, argv out. That is
the shape we want. The job here is to keep it pure and deterministic.

### Keep `src/harnesses/*`

The harness registry should remain the place where CLI syntax is declared.
These modules should be boring:

- binary name
- base subcommand
- flags for model/session/prompt/cwd
- any pure formatting hooks that are still needed

No spawning. No parsing. No persistence. No product semantics.

### Keep `src/resolve.ts`

This is a small utility and it can stay small.

## What to split

### Split `src/run.ts`

`run.ts` should be reduced to a compatibility layer and a public facade. The
real work should move into internal modules:

- `src/execute.ts` for generic process lifecycle
- `src/parsers/index.ts` for parser selection
- `src/parsers/*.ts` for one parser per harness
- `src/session.ts` for session id / resume / fork helpers
- `src/heartbeat.ts` for silence detection if the package still needs it

That split makes the boundaries obvious:

- executor = process mechanics
- parser = output interpretation
- harness config = argv formatting

### Split `src/fork-emulation.ts` if needed

If fork emulation remains, it should be a dedicated session helper used by the
executor, not a feature hiding inside harness config. The helper can stay in the
same file if that file remains a single explicit utility, but its call site must
be in the executor path, not the config layer.

## What to delete

### Delete app/product semantics from the submodule

The package should not contain:

- merge
- swarm
- conversation runtime
- UI-oriented subagent state
- app-specific recovery logic

If the consumer app needs those ideas, it can build them on top of the unified
event stream. The submodule should not model them directly.

### Delete hidden runtime behavior from harness config

Any config field that mutates files or performs runtime side effects should be
removed from `HarnessConfig`. Pure formatting hooks are fine. Runtime behavior
is not.

### Delete redundant execution APIs

The package should not expose a pile of overlapping entry points. If the public
surface can be reduced to one execution function plus one build function, that
is the preferred shape.

In particular, the long-term direction is:

- keep `buildCommand`
- keep one execution entry point
- deprecate or internalize alternate wrappers that do the same thing

### Delete parser logic from `run.ts`

Any code in `run.ts` that is really parsing should move out. That includes:

- line classification
- JSON shape handling
- provider-specific terminal event logic
- session extraction from output
- auth prompt heuristics

Those belong to parser modules.

## Public API direction

The package should feel like this from the outside:

```ts
import { buildCommand, executeCommand } from '@nbardy/agent-cli';

const spec = buildCommand('codex', { prompt: 'hello', model: 'gpt-5.3-codex' });
const handle = executeCommand({ harness: 'codex', prompt: 'hello', cwd: process.cwd() });
```

That is enough. New capabilities should normally appear as request fields, not
new top-level public functions.

## Tests

The tests should map to the same boundaries as the code:

### Contract tests

Contract tests should verify only the deterministic wrapper behavior.

- `buildCommand` -> argv
- parser fixtures -> raw harness output -> normalized events
- executor lifecycle against small local shims

These are the tests that protect the public contract.

### Live tests

Live tests should run against real binaries only when explicitly enabled.

They should validate:

- the wrapper can talk to the real harness
- the event stream is still normalized enough to be useful
- session resume works against a real session id
- manual smoke probes still reflect current harness behavior

### Manual tests

Manual tests should be checked in as scripts and captures under
`manual_tests/`. They are not auto-run. Their job is to help humans inspect
unstable behavior when harness APIs change or regress.

## Migration path

The cleanest migration is incremental:

1. keep the current public exports
2. move parsing out of `run.ts` into per-harness parser files
3. move process lifecycle into a generic executor
4. move session/fork helpers into a dedicated session module
5. keep `run.ts` as a thin facade that delegates to the new modules
6. delete the old inline helpers once the contract tests cover the new path

This avoids a hard rewrite while still restoring the original boundary shape.

## Bottom line

The minimal executor should be boring. That is the point.

If a change makes `run.ts` more provider-aware, more stateful, or more product-
specific, it is moving in the wrong direction.
