# Manual Tests

Live harness probes that are intentionally **not** part of the automated test suite.

Use these when a provider CLI changes its event format or runtime behavior and you need
real logs from the actual harness, not a shimmed contract test.

## Why this exists

`@nbardy/agent-cli` needs two kinds of coverage:

1. Automated tests:
   fast, deterministic parser/build contract checks
2. Manual tests:
   real Codex/Claude runs that capture raw output for investigation

The automated tests catch regressions in our normalization logic.
The manual tests help when the upstream harness API changes underneath us.

The manual runner prepends `[_HIDE_TEST_]` by default so the resulting sessions
stay on disk but do not appear in the `unleashd` UI. Use `--no-hide-test-prefix`
only when you explicitly want the run to be visible.

## Output

Each run writes a timestamped directory under `manual_tests/runs/` with:

- `run.log` — combined stdout/stderr timeline
- `stdout.log` — raw stdout only
- `stderr.log` — raw stderr only
- `prompt.txt` — exact prompt sent
- `command.json` — argv or shared-cli request metadata
- `summary.json` — exit status, timeout flag, file checks, stdout event counts

## Built-in scenario

`subagents`

- Codex prompt uses `spawn_agent`
- Claude prompt uses `Task`
- Each sub-agent should write one confirmation file containing `test-confirmed`

## Common commands

```bash
pnpm manual:subagents:codex:raw
pnpm manual:subagents:codex:shared
pnpm manual:subagents:claude:raw
pnpm manual:subagents:claude:shared
```

## Generic capture runner

```bash
node manual_tests/capture-live-run.mjs --runner raw --harness codex --scenario subagents
node manual_tests/capture-live-run.mjs --runner shared --harness codex --scenario subagents
node manual_tests/capture-live-run.mjs --runner raw --harness claude --scenario subagents
```

Override the prompt when you need a one-off probe:

```bash
node manual_tests/capture-live-run.mjs \
  --runner shared \
  --harness codex \
  --prompt-file /absolute/path/to/prompt.txt
```

Useful overrides:

- `--model <id>`
- `--cwd <path>`
- `--timeout-ms <n>`
- `--out-dir <path>`
- `--no-debug-events` for shared runs when you want less stderr noise
