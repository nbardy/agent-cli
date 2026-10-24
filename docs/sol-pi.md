# SoL-Pi harness

The `pi` harness displays as **SoL-Pi** in Unleashd. It uses unmodified Pi
1.1.0 and SoL-Pi PR #105 at
`aed9f1362beb5ce3f4b87d79e7320329c6a39d75`. That PR is not merged upstream.

Install the separate pinned runtime (does not replace an existing `pi` command):

```sh
node vendor/agent-cli-tool/scripts/install-sol-pi.mjs
```

The installer writes `~/.local/bin/sol-pi` and uses
`~/.local/share/unleashd/sol-pi`. Put `~/.local/bin` on the backend's PATH.
It pins the internal Pi packages too, checks the runtime dependency audit,
and enables all four SoL mechanisms in `~/.pi/agent/sol-pi.json` if that file
does not exist. It refuses to overwrite an existing partial configuration.
`PI_CODING_AGENT_DIR` selects another Pi configuration directory. Two optional
positional arguments select a runtime directory and a bin directory for tests.

Pi owns model authentication; the native Claude, Codex and Muse CLI logins do
not establish Pi access. Run `sol-pi /login` to configure available providers.
The catalog offers these exact routes:

| Label | Pi model route |
| --- | --- |
| Opus 5.5 | `anthropic/claude-opus-5-5` |
| GPT-6.1 Sol | `openai-codex/gpt-6.1-sol` |
| Muse Wonder 1.0 | `meta/muse-wonder-1.0` |

Run `sol-pi --list-models` to check actual availability. Pi can refresh its
catalog with `sol-pi update --models`. If a route is not supplied by a configured
provider, add it to Pi's `models.json` or load a provider extension. A Meta
route needs the owner's actual compatible endpoint and authentication;
the harness does not infer a Muse CLI token or change provider protocols.
The custom model field accepts other `provider/model` routes verbatim.
Catalog inclusion is not a claim that an account can run the model.

SoL-Pi's reducer has a separate route, defaulting upstream to
`openai-codex/gpt-5.6-luna`. Configure its provider/model in `sol-pi.json` if
that route is unavailable. The upstream reducer preserves the original
observation when reduction cannot run. Pi's Anthropic subscription docs
describe third-party use as billed extra usage; check that choice when logging in.

Buddy MCP uses Pi's native streamable HTTP/stdio clients and native codemode.
The per-turn extension registers the existing canonical server specs; it
does not implement an MCP client. Required servers must expose native tools
and codemode before the agent starts. Startup times out after 15 seconds and
fails the process before a provider call. Same-name configured servers are
refused because Pi would otherwise override the turn's endpoint/token.
HTTP secrets use environment references; temporary extensions are removed
by the existing execution journal's terminal cleanup.

Live output ends at `agent_settled`, not an internal `agent_end`, so SoL-Pi's
compaction continuation remains in the same Unleashd turn. Session create,
resume and fork use Pi's native flags. Execution journals, cancellation and
backend adoption use the common runner. The native transcript is ingested
by Unleashd's Rust fold: appends read new bytes, a branch change rebuilds the
active path, and billed usage includes abandoned branches.

Local boundary checks (no provider spend):

```sh
AGENT_CLI_TEST_PI_ROOT=/path/to/SoL-Pi-checkout \
  node --experimental-strip-types --test vendor/agent-cli-tool/test/pi.test.ts
cargo test --manifest-path crates/Cargo.toml -p unleashd-ingest \
  --no-default-features --test pi
```

For an installer-produced runtime, set `AGENT_CLI_TEST_PI_ROOT` to the runtime
directory and `AGENT_CLI_TEST_SOL_SOURCE` to `SoL-Pi/src/sol-pi/index.ts` within it.
The real-process test uses Pi's faux provider and a local MCP server, exercising
codemode, saved session resume, journal adoption and required-tool failure.
It does not verify live model credentials or measure token savings.
