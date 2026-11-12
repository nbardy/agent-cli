import type {
  BuildOptions,
  CommandSpec,
  GeminiAlias,
  Harness,
  HarnessName,
  McpServerSpec,
  TurnCapabilities,
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
export const MUSE_REASONING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra',
] as const;
export type MuseReasoningLevel = (typeof MUSE_REASONING_LEVELS)[number];
export type TurnMode = 'conversation' | 'single-shot';
export type CompletionReason = 'success' | 'out_of_tokens' | 'error' | 'killed';
export type UnifiedSubagentStatus = 'pending' | 'running' | 'completed' | 'error';

export interface UnifiedSubagentStateEvent {
  type: 'subagent.state';
  id: string;
  status: UnifiedSubagentStatus;
  /** Completed parent operation that observed this child state. */
  operation: 'spawn' | 'wait' | 'message';
  /** Harness item ID, when supplied; scopes replay detection to this child and turn. */
  operationId?: string;
  parentId?: string;
  rawStatus?: string;
  /** Display label, including the adapter's fallback when the prompt is absent. */
  description: string;
  message?: string;
}

/**
 * A harness-managed task's lifecycle: a sub-agent or shell the harness runs and
 * tracks by `taskId`. Claude streams these as `system` task_started /
 * task_notification lines (recorded: test/fixtures/claude-2.1.283-background-agent.jsonl).
 * `background` is true when the task outlives the tool call that launched it
 * (`run_in_background`): `claude -p` then waits for it after the parent turn
 * goes idle, so a consumer can tell "silent but waiting" from "stalled".
 * `status` is the harness's own word (completed, failed, stopped), verbatim.
 */
export type UnifiedTaskEvent =
  | {
      type: 'task.started';
      taskId: string;
      toolUseId: string;
      background: boolean;
      description: string;
    }
  | { type: 'task.finished'; taskId: string; toolUseId: string; status: string };

type BaseExecuteCommandRequest<THarness extends HarnessName> = {
  harness: THarness;
  mode: TurnMode;
  prompt: string;
  cwd: string;
  model?: string;
  extraArgs?: readonly string[];
  /** Canonical MCP servers (stdio or http); the selected harness owns provider-specific encoding. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
  sessionId?: string;
  resumeSessionId?: string;
  forkSessionId?: string;
  yolo?: boolean;
  /**
   * What this turn may do (types.ts `TurnCapabilities`). Absent: the harness's default
   * invocation, byte for byte as before (`yolo` decides). Present: the harness's own flags for
   * the set replace the permission bypass and `yolo` is not read; the request must then carry no
   * `mcpServers`, `extraArgs`, `fullAuto` or `webSearch` (each would widen or override the set,
   * and Claude's two `--settings` would not merge), or `executeCommand` throws.
   */
  capabilities?: TurnCapabilities;
  debugRawEvents?: boolean;
  /** Journal dir (journal.ts) another process can `attachExecution`; absent = private temp. */
  journalDir?: string;
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

type NoExtraExecuteCommandRequest<
  THarness extends Exclude<HarnessName, 'codex' | 'claude' | 'muse' | 'pi'>,
> = BaseExecuteCommandRequest<THarness> & {
  reasoningEffort?: never;
  fullAuto?: never;
};

export type ExecuteCommandRequest =
  | CodexExecuteCommandRequest
  | ClaudeExecuteCommandRequest
  | (BaseExecuteCommandRequest<'pi'> & { reasoningEffort?: string; fullAuto?: never })
  | MuseExecuteCommandRequest
  | NoExtraExecuteCommandRequest<'opencode'>
  | NoExtraExecuteCommandRequest<'gemini'>
  | NoExtraExecuteCommandRequest<'cursor'>
  | NoExtraExecuteCommandRequest<GeminiAlias>;

/** Pricing classes reported by the harness, never inferred from a context meter. */
export type TokenUsage =
  | {
      t: 'reported';
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite5m: number;
      cacheWrite1h: number;
    }
  | { t: 'unreported'; why: string };

/** A request's live context, or the session aggregate (which must never update a context meter).
 * Totals replace request measurements for accounting. On resumed sessions they include earlier turns.
 * A fresh execution, such as runTurn, has exactly one turn's total. */
export type TurnUsage =
  | { t: 'total'; tokens: TokenUsage }
  | {
      t: 'request';
      contextTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
      contextWindow?: number;
      tokens: TokenUsage;
    };

export type UnifiedAgentEvent =
  | { type: 'session.started'; sessionId: string }
  // Provider-generated conversation label. Claude emits ai-title/custom-title
  // lines; other harnesses currently emit none. Consumers take custom over ai
  // (the server owns that precedence); the event carries the raw observation.
  | { type: 'session.title'; title: string; source: 'ai' | 'custom' }
  | { type: 'turn.started' }
  | { type: 'text.delta'; text: string }
  | {
      type: 'tool.use';
      name: string;
      input: Record<string, unknown>;
      displayText?: string;
      phase?: 'started' | 'completed';
    }
  | { type: 'tool.result'; output: unknown; isError?: boolean }
  | UnifiedSubagentStateEvent
  | UnifiedTaskEvent
  | { type: 'progress'; source: string; data?: Record<string, unknown> }
  | { type: 'out_of_tokens'; message: string }
  // Provider usage with explicit scope; silence means the harness reports none.
  | { type: 'usage'; usage: TurnUsage }
  | { type: 'error'; message: string }
  // `text` is the final assistant message, separated from progress by createParser.
  // UI history still accumulates text.delta; consumers of answers use this snapshot.
  // Optional for failure events and older callers that construct events themselves.
  | { type: 'turn.complete'; reason: CompletionReason; text?: string }
  | { type: 'stderr'; text: string };

export interface ExecuteCommandCompletion {
  reason: CompletionReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId: string;
}

/** One journaled execution, followed from its journal (spawned here or adopted). */
export interface ExecutionHandle {
  /** The wrapper's pid, which is also its process group. */
  pid: number;
  journalDir: string;
  events: AsyncIterable<UnifiedAgentEvent>;
  sessionId: Promise<string>;
  completed: Promise<ExecuteCommandCompletion>;
  /** Signal the execution's whole process group. */
  stop: (signal?: NodeJS.Signals) => void;
}

export interface ExecuteCommandHandle extends ExecutionHandle {
  spec: CommandSpec;
}

export type ExecuteTurnRequest = ExecuteCommandRequest;
export type ExecuteTurnEvent = UnifiedAgentEvent;
export type ExecuteTurnCompletion = ExecuteCommandCompletion;
export type ExecuteTurnHandle = ExecuteCommandHandle;

export type RuntimeHarness = Harness;
