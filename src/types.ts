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
export type Harness = 'claude' | 'codex' | 'opencode' | 'gemini' | 'cursor';
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
   * Flags for forking a session — resume its full transcript (including tool
   * calls/results) into a NEW session id, without polluting the original.
   *
   * When defined, the harness natively supports non-interactive fork at the
   * CLI-flag level (e.g. claude `--resume <id> --fork-session`, opencode
   * `--session <id> --continue --fork`).
   *
   * When undefined, the caller must emulate fork at runtime (copy the
   * on-disk session file to a new id, then use sessionResumeFlags on the
   * copy). See docs/fork.md. Codex + gemini are currently in this bucket —
   * TBD native support.
   */
  readonly sessionForkFlags?: (sessionId: string) => readonly string[];

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
   * Only codex uses this (for `-c model_reasoning_effort=X`).
   * Returns flags to append, or empty array if not supported.
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
   * Reasoning/effort level (codex only).
   * Adds `-c model_reasoning_effort=X` to the command.
   *
   * Two ways to specify effort for codex:
   * 1. Composite model ID: model='gpt-5.3-codex-high' (decomposeModel handles it)
   * 2. Separate reasoning: model='gpt-5.3-codex', reasoning='high' (this field)
   *
   * If the model ID already encodes effort, this field is ignored.
   */
  reasoning?: string;

  /** Extra args appended after all generated args (project-specific flags) */
  extraArgs?: readonly string[];
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
}
