import type { ChildProcess } from 'node:child_process';
import type {
  BuildOptions,
  CommandSpec,
  GeminiAlias,
  Harness,
  HarnessName,
  McpServerSpec,
} from './types.ts';

export interface RunOptions extends BuildOptions {
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
  onStdoutState?: (state: StdoutStreamState) => void;
  /** Start a separate process group for group-scoped termination. The owner keeps the child referenced. */
  detached?: boolean;
}

export interface StdoutStreamState {
  event: 'attached' | 'resume' | 'pause' | 'close';
  readableFlowing: boolean | null;
  readableLength: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spec: CommandSpec;
}

export type ClaudeReasoningLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const CODEX_REASONING_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type CodexReasoningLevel = (typeof CODEX_REASONING_LEVELS)[number];
export const MUSE_REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'] as const;
export type MuseReasoningLevel = (typeof MUSE_REASONING_LEVELS)[number];
export type TurnMode = 'conversation' | 'single-shot';
export type CompletionReason = 'success' | 'out_of_tokens' | 'error' | 'killed';
export type UnifiedSubagentStatus = 'pending' | 'running' | 'completed' | 'error';

export interface UnifiedSubagentStateEvent {
  type: 'subagent.state';
  id: string;
  status: UnifiedSubagentStatus;
  parentId?: string;
  rawStatus?: string;
  description?: string;
  message?: string;
}

type BaseExecuteCommandRequest<THarness extends HarnessName> = {
  harness: THarness;
  mode: TurnMode;
  prompt: string;
  cwd: string;
  model?: string;
  extraArgs?: readonly string[];
  /** Canonical stdio MCP servers; the selected harness owns provider-specific encoding. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
  sessionId?: string;
  resumeSessionId?: string;
  forkSessionId?: string;
  yolo?: boolean;
  debugRawEvents?: boolean;
  /** Start a separate process group for group-scoped termination. The owner keeps the child referenced. */
  detached?: boolean;
};

type CodexExecuteCommandRequest = BaseExecuteCommandRequest<'codex'> & {
  reasoningEffort?: string;
  fullAuto?: boolean;
  /**
   * Enable codex's live web search tool.
   *
   * Codex's own `--search` is a TOP-LEVEL flag -- `codex --search exec ...` --
   * so it cannot be reached through `extraArgs`, which are appended after the
   * `exec` subcommand (`codex exec --search` is rejected outright). The
   * equivalent that does work after the subcommand is the config override
   * `-c tools.web_search=true`, verified against `codex --strict-config`.
   */
  webSearch?: boolean;
};

type ClaudeExecuteCommandRequest = BaseExecuteCommandRequest<'claude'> & {
  reasoningEffort?: string;
  fullAuto?: never;
};

type MuseExecuteCommandRequest = BaseExecuteCommandRequest<'muse'> & {
  reasoningEffort?: string;
  fullAuto?: never;
};

type NoExtraExecuteCommandRequest<THarness extends Exclude<HarnessName, 'codex' | 'claude' | 'muse'>> =
  BaseExecuteCommandRequest<THarness> & {
    reasoningEffort?: never;
    fullAuto?: never;
  };

export type ExecuteCommandRequest =
  | CodexExecuteCommandRequest
  | ClaudeExecuteCommandRequest
  | MuseExecuteCommandRequest
  | NoExtraExecuteCommandRequest<'opencode'>
  | NoExtraExecuteCommandRequest<'gemini'>
  | NoExtraExecuteCommandRequest<'cursor'>
  | NoExtraExecuteCommandRequest<GeminiAlias>;

/**
 * Provider-counted tokens for one request. Every field is a number the harness
 * itself reported -- this type never carries an estimate, so a consumer can
 * treat it as billing truth rather than a guess.
 *
 * `contextTokens` is canonicalized here because the harnesses disagree on what
 * "input" means: claude and opencode report cache hits in SEPARATE fields
 * that must be added back to input. Each parser resolves its own convention
 * so nothing downstream has to know which harness spoke. Codex emits no
 * `usage` event at all: its exec-stdout `input_tokens` is the
 * session-cumulative total, not one request's context (2026-09-22: 16,062,762
 * stdout vs 244,247 per-request on the same session), so per-request codex
 * truth comes only from the rollout file.
 */
export interface TurnUsage {
  /** Total input the provider counted for the latest request: the live context size. */
  contextTokens: number;
  outputTokens: number;
  /** Portion of `contextTokens` served from cache. Absent when the harness does not split it out. */
  cachedInputTokens?: number;
  /** Portion of `contextTokens` written to cache. Absent when the harness does not report it. */
  cacheWriteTokens?: number;
  /**
   * The model's context window. Absent means the harness does not report one
   * (claude and `codex exec` both omit it) -- NOT that the window is unknown
   * to the caller, who can resolve it from the model id.
   */
  contextWindow?: number;
}

export type UnifiedAgentEvent =
  | { type: 'session.started'; sessionId: string }
  // Provider-generated conversation label. Claude emits ai-title/custom-title
  // lines; other harnesses currently emit none. Consumers take custom over ai
  // (the server owns that precedence); the event carries the raw observation.
  | { type: 'session.title'; title: string; source: 'ai' | 'custom' }
  | { type: 'turn.started' }
  | { type: 'text.delta'; text: string }
  | { type: 'tool.use'; name: string; input: Record<string, unknown>; displayText?: string }
  | { type: 'tool.result'; output: unknown; isError?: boolean }
  | UnifiedSubagentStateEvent
  | { type: 'progress'; source: string; data?: Record<string, unknown> }
  | { type: 'out_of_tokens'; message: string }
  // Provider-counted usage for the request that just completed. Emitted only
  // when the harness reports real numbers; silence means it reports none.
  | { type: 'usage'; usage: TurnUsage }
  | { type: 'error'; message: string }
  // `text` carries the complete final message when the harness reports one
  // separately from its incremental deltas (muse does). It is NOT a substitute
  // for accumulating text.delta -- it is absent on harnesses that only stream.
  | { type: 'turn.complete'; reason: CompletionReason; text?: string }
  | { type: 'stderr'; text: string };

export interface ExecuteCommandCompletion {
  reason: CompletionReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId: string;
  spec: CommandSpec;
}

export interface ExecuteCommandHandle {
  child: ChildProcess;
  spec: CommandSpec;
  events: AsyncIterable<UnifiedAgentEvent>;
  sessionId: Promise<string>;
  completed: Promise<ExecuteCommandCompletion>;
  stop: (signal?: NodeJS.Signals) => void;
}

export type ExecuteTurnRequest = ExecuteCommandRequest;
export type ExecuteTurnEvent = UnifiedAgentEvent;
export type ExecuteTurnCompletion = ExecuteCommandCompletion;
export type ExecuteTurnHandle = ExecuteCommandHandle;

export type RuntimeHarness = Harness;
