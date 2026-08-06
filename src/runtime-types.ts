import type { ChildProcess } from 'node:child_process';
import type { BuildOptions, CommandSpec, GeminiAlias, Harness, HarnessName } from './types.ts';

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

export type UnifiedAgentEvent =
  | { type: 'session.started'; sessionId: string }
  | { type: 'turn.started' }
  | { type: 'text.delta'; text: string }
  | { type: 'tool.use'; name: string; input: Record<string, unknown>; displayText?: string }
  | UnifiedSubagentStateEvent
  | { type: 'progress'; source: string; data?: Record<string, unknown> }
  | { type: 'out_of_tokens'; message: string }
  | { type: 'error'; message: string }
  | { type: 'turn.complete'; reason: CompletionReason }
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
