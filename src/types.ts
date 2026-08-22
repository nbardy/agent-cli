/**
 * Canonical domain types for CLI agent invocation.
 *
 * These types encode the semantic space of "how to invoke a CLI agent."
 * All CLI syntax knowledge lives in HarnessConfig instances — one per agent.
 * The build function reads these configs to assemble argv deterministically.
 */

// =============================================================================
// Sum type: supported CLI agents
// =============================================================================

/** Adding a harness = adding one entry here + one config in harnesses/ */
export type Harness = 'claude' | 'codex' | 'opencode' | 'gemini' | 'cursor' | 'muse';
export type GeminiAlias = `gemini${number}`;
export type HarnessName = Harness | GeminiAlias;

// =============================================================================
// Prompt & stdin behavior
// =============================================================================

/**
 * How the prompt text is delivered to the CLI process.
 *
 * flag:     Value of a named flag (e.g. `-p "prompt"`)
 * cli-arg:  Last positional argument (e.g. `opencode run "prompt"`)
 * cli-sep:  After a separator (e.g. `codex exec -- "prompt"`)
 */
export type PromptDelivery = 'flag' | 'cli-arg' | 'cli-sep';

/**
 * What the caller should do with process stdin after spawning.
 *
 * close:    Write "" and close immediately (prevent hang)
 * prompt:   Write the prompt text then close
 * pipe:     Leave open for caller to manage (interactive mode)
 */
export type StdinBehavior = 'close' | 'prompt' | 'pipe';

/**
 * What the caller should expect from process stdout.
 *
 * NOTE ON MOTIVATION: Even when CLI agents self-persist to disk (like Gemini or Codex),
 * they typically only write the session file at the very end of a turn.
 * Progressive stdout streaming (jsonl) is mandatory for real-time UI interactivity
 * (the "typewriter" effect) to prevent the UI from appearing frozen during long
 * generation tasks. Disk should be treated as a persistence/rehydration layer,
 * while stdout is the live interaction layer.
 *
 * jsonl:    Stream of JSON lines (claude, codex, opencode, gemini)
 * text:     Plain text output (single-shot mode)
 * ignore:   Output is irrelevant or handled out-of-band
 */
export type StdoutBehavior = 'jsonl' | 'text' | 'ignore';

// =============================================================================
// MCP (Model Context Protocol) servers
// =============================================================================

/**
 * Canonical, provider-agnostic description of one stdio MCP server.
 *
 * Callers describe WHAT to launch; each HarnessConfig.mcp encoder owns HOW that
 * gets expressed on its CLI (TOML `-c` fragments, a JSON flag, an env var, ...).
 * No caller should ever encode per-CLI MCP syntax itself.
 */
export interface McpServerSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Fail the turn if the server cannot start, rather than running without it. */
  readonly required?: boolean;
}

/**
 * The result of encoding MCP servers for one harness: extra argv entries,
 * extra process env, or both. A harness may need only one of the two
 * (opencode is env-only; claude and codex are args-only).
 */
export interface McpEncoding {
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

// =============================================================================
// Harness config — pure data describing CLI syntax
// =============================================================================

/**
 * Pure data structure describing how to invoke a CLI agent.
 *
 * One instance per harness. No imperative code — only small pure functions
 * for model decomposition and session flag construction.
 *
 * This is the ONLY place that encodes CLI flag syntax.
 */
export interface HarnessConfig {
  /** CLI binary name (e.g. 'claude', 'codex') */
  readonly binary: string;

  /** Subcommand(s) after binary (e.g. ['exec'] for codex, [] for claude) */
  readonly baseCmd: readonly string[];

  /** Flags to bypass all confirmation prompts */
  readonly bypassFlags: readonly string[];

  /**
   * Encode MCP servers for this CLI.
   *
   * ABSENT means this harness has NO MCP support at all — not "not wired up
   * yet". buildCommand rejects required servers and ignores optional servers
   * for such harnesses. `harnessSupportsMcp(name)` lets callers reject an
   * incompatible job before building it. Every harness that leaves this field
   * out carries a comment saying why.
   *
   * Encoders are additive: they must never disable the user's own
   * globally-configured MCP servers.
   */
  readonly mcp?: (servers: Readonly<Record<string, McpServerSpec>>) => McpEncoding;

  /** Flag name for model selection (e.g. '--model' or '-m') */
  readonly modelFlag: string;

  /** How the prompt is delivered to the CLI */
  readonly promptVia: PromptDelivery;

  /** Flag name when promptVia is 'flag' (e.g. '-p') */
  readonly promptFlag?: string;

  /** Separator when promptVia is 'cli-sep' (e.g. '--') */
  readonly promptSep?: string;

  /** What the caller should do with process stdin */
  readonly stdin: StdinBehavior;

  /** What the caller should expect from process stdout */
  readonly stdout: StdoutBehavior;

  /** Extra args appended to all commands (e.g. ['--output-format', 'stream-json']) */
  readonly extraArgs?: readonly string[];

  /** CLI flag for working directory (undefined = use process cwd option) */
  readonly cwdFlag?: string;

  /** Flags for creating a new session with this ID */
  readonly sessionCreateFlags?: (sessionId: string) => readonly string[];

  /**
   * Flags for resuming an existing session.
   * For codex, this returns subcommand args ('resume', id) that go after baseCmd.
   * For claude, this returns flag args ('--resume', id).
   */
  readonly sessionResumeFlags?: (sessionId: string) => readonly string[];

  /**
   * Provider-SESSION fork strategy for merge reviews — NOT Unleashd's Chat
   * "Fork" button. Chat Fork is a soft handoff (new conversation + draft /
   * pasted transcript) and never sets these fields.
   *
   * Two mutually-exclusive shapes, one per harness:
   *
   *   NATIVE:   sessionForkFlags is set → CLI has a real fork flag
   *             (claude `--resume <id> --fork-session`, opencode
   *             `--session <id> --continue --fork`). executeCommand
   *             passes fork=true to buildCommand and the CLI mints a new id.
   *
   *   EMULATED: emulateFork is set → no CLI flag exists, so we copy the
   *             source session file to a new uuid on disk and then --resume
   *             the copy. Source stays byte-identical. See fork-emulation.ts.
   *
   *   NEITHER:  harness does not support merge session-fork — executeCommand
   *             throws if a caller passes forkSessionId. Chat soft Fork is
   *             still fine without these.
   *
   * The two are mutually exclusive by construction: a harness either has
   * a native fork flag OR needs emulation, never both.
   */
  readonly sessionForkFlags?: (sessionId: string) => readonly string[];

  /**
   * Emulated-fork implementation for harnesses without a native fork flag.
   * Called with the SOURCE session id; returns the new session id to --resume.
   * Must be synchronous (executeCommand is a sync factory).
   */
  readonly emulateFork?: (sourceSessionId: string) => { readonly newSessionId: string };

  /**
   * Model ID decomposition. Returns the full set of flags for model selection.
   * When provided, replaces the default `[modelFlag, modelId]` behavior.
   *
   * Used for:
   * - Codex composite IDs: 'gpt-5.3-codex-high' → ['-m', 'gpt-5.3-codex', '-c', 'model_reasoning_effort=high']
   * - OpenCode legacy format: 'openai/foo' → ['-m', 'opencode/foo']
   */
  readonly decomposeModel?: (modelId: string) => readonly string[];

  /**
   * Reasoning/effort flags. Called when BuildOptions.reasoning is set.
   * Currently used by codex (`-c model_reasoning_effort=X`) and claude
   * (`--effort X`). Returns flags to append, or empty array if not supported.
   *
   * This is separate from decomposeModel because oompa passes reasoning
   * as a standalone parameter (codex:model:reasoning), while claude-web-view
   * encodes it in the composite model ID (gpt-5.3-codex-high).
   * Both paths produce the same CLI flags.
   */
  readonly reasoningFlags?: (level: string) => readonly string[];
}

// =============================================================================
// Build options — what the caller provides
// =============================================================================

/** Options for building a CLI command. Caller provides these. */
export interface BuildOptions {
  /** Model identifier (harness-specific, passed through or decomposed) */
  model?: string;

  /** Prompt text */
  prompt?: string;

  /** Session ID (for create or resume) */
  sessionId?: string;

  /** Whether to resume an existing session (vs create new) */
  resume?: boolean;

  /**
   * Whether to FORK an existing session — inherit its full transcript into a
   * new session id, leaving the original untouched. Use with sessionId set to
   * the SOURCE session (the one being forked from).
   *
   * Only valid for harnesses that set sessionForkFlags. For harnesses without
   * native support (codex, gemini), caller must emulate via cp+resume before
   * calling buildCommand — see sessionForkFlags docs on HarnessConfig.
   *
   * Mutually exclusive with `resume` — fork takes precedence.
   */
  fork?: boolean;

  /** Working directory (used with cwdFlag or passed to process options) */
  cwd?: string;

  /** Whether to include permissions bypass flags */
  bypassPermissions?: boolean;

  /**
   * Reasoning/effort level.
   *   codex  → `-c model_reasoning_effort=X`
   *   claude → `--effort X`  (low | medium | high | xhigh | max)
   *
   * Two ways to specify effort for codex:
   * 1. Composite model ID: model='gpt-5.3-codex-high' (decomposeModel handles it)
   * 2. Separate reasoning: model='gpt-5.3-codex', reasoning='high' (this field)
   *
   * If the model ID already encodes effort, this field is ignored.
   * Ignored for harnesses without reasoningFlags (opencode, gemini, cursor).
   */
  reasoning?: string;

  /** Extra args appended after all generated args (project-specific flags) */
  extraArgs?: readonly string[];

  /**
   * MCP servers to expose to the agent, keyed by server name.
   *
   * Encoded by the harness config's `mcp` encoder. Harnesses with no `mcp`
   * encoder ignore this field entirely (see HarnessConfig.mcp).
   */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
}

// =============================================================================
// Command spec — what the tool outputs
// =============================================================================

/**
 * Everything a caller needs to spawn the CLI process.
 * The build function produces this; callers exec it.
 */
export interface CommandSpec {
  /** Full argv: [binary, ...args] */
  argv: string[];

  /** What the caller should do with process stdin */
  stdin: StdinBehavior;

  /** What the caller should expect from process stdout */
  stdout: StdoutBehavior;

  /** The prompt text (for stdin delivery or caller reference) */
  prompt?: string;

  /**
   * Extra environment variables the process must be spawned with (e.g.
   * opencode's OPENCODE_CONFIG_CONTENT). MERGE these over the inherited
   * environment — never use them as a replacement env.
   */
  env?: Readonly<Record<string, string>>;
}
