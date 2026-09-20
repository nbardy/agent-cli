# @nbardy/agent-cli

Shared CLI wrapper that provides a unified interface for Gemini, OpenCode, Claude, and Codex.

It centralizes command building, process execution, and event normalization so other tools can integrate multiple agent CLIs through one consistent API.

For real-harness debugging utilities that are not part of automated test runs, see `manual_tests/`.

## Token usage

Harnesses that report provider-counted tokens emit a `usage` event carrying
`TurnUsage`. `contextTokens` is canonical: the size of the context the provider
actually saw on that request. Nothing here is estimated — a harness that
reports no numbers emits no event.

The three conventions disagree, which is why canonicalization lives in the
parsers and not in callers:

| harness | source | contextTokens | context window |
|---|---|---|---|
| claude | `assistant` message, main thread only | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` — cache fields are separate addends | not reported |
| codex | `turn.completed.usage` | `input_tokens` alone — `cached_input_tokens` is a SUBSET of it | not on the exec stream (lives in the internal `token_count` event) |
| opencode | `step_finish` → `part.tokens` | `input + cache.read + cache.write`; its `total` also folds in output and reasoning | not reported |
| muse | — | not on stdout; `model_completed.usage` is only in the durable session log | — |

Two traps, both pinned by `test/usage.test.ts`:

- claude's `result` event carries a usage block that is the **turn aggregate**,
  not a context size (measured 70,213 vs a real 23,948 on the same turn), and
  its subagent messages measure the subagent's own context.
- `gemini` and `cursor` have not been investigated; they emit no `usage` event
  because nobody has looked, not because they lack the data.
