/**
 * @nbardy/agent-cli — Shared CLI agent invocation tool.
 *
 * Single source of truth for how to invoke Claude, Codex, OpenCode, Gemini CLIs.
 * Both oompa_loompas (Clojure, shells out to CLI) and claude-web-view
 * (TypeScript, imports this library) consume this package.
 *
 * Usage (library — run):
 *   import { runCommand } from '@nbardy/agent-cli';
 *   const { done } = runCommand('claude', { model: 'opus', prompt: 'hello', sessionId: 'abc' });
 *   const { exitCode } = await done;
 *
 * Usage (library — build only):
 *   import { buildCommand } from '@nbardy/agent-cli';
 *   const spec = buildCommand('claude', { model: 'opus', prompt: 'hello', sessionId: 'abc' });
 *
 * Usage (CLI):
 *   agent-cli run --harness claude --model opus --prompt "hello" --session abc
 */

export type {
  Harness,
  HarnessName,
  GeminiAlias,
  HarnessConfig,
  BuildOptions,
  CommandSpec,
  PromptDelivery,
  StdinBehavior,
  StdoutBehavior,
} from './types.ts';

export { buildCommand } from './build.ts';
export { runCommand, executeCommand, executeTurn } from './run.ts';
export type {
  RunOptions,
  RunResult,
  UnifiedAgentEvent,
  ExecuteCommandRequest,
  ExecuteCommandCompletion,
  ExecuteCommandHandle,
  ExecuteTurnRequest,
  ExecuteTurnEvent,
  ExecuteTurnCompletion,
  ExecuteTurnHandle,
  CodexReasoningLevel,
  TurnMode,
  CompletionReason,
} from './run.ts';
export { getHarness, listHarnesses, registry } from './harnesses/index.ts';
export { resolveBinary } from './resolve.ts';
