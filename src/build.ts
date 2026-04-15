import type { HarnessConfig, BuildOptions, CommandSpec, HarnessName } from './types.ts';
import { getHarness } from './harnesses/index.ts';

/**
 * Build a CLI command from harness name + options.
 *
 * This is the primary entry point for both library and CLI usage.
 * All CLI syntax knowledge lives in the harness configs — this function
 * just reads config fields and appends the appropriate flags.
 *
 * It does NOT handle:
 * - Output parsing (project-specific)
 * - Process lifecycle (project-specific)
 * - Streaming/format flags (caller appends via extraArgs)
 */
export function buildCommand(harness: HarnessName | string, options: BuildOptions = {}): CommandSpec {
  const config = getHarness(harness);
  return buildFromConfig(config, options);
}

/**
 * Single handler: config data → CommandSpec.
 *
 * No structural branching — config fields drive everything.
 * The switch on promptVia is algorithmic (reading a field value
 * on an already-selected config), not structural (asking "what kind
 * of harness is this?").
 *
 * Flag ordering:
 *   binary → baseCmd → sessionResume (if resuming)
 *   → bypassFlags → cwdFlag (if NOT resuming) → modelFlags
 *   → sessionCreate (if NOT resuming) → prompt → extraArgs
 *
 * This ordering handles Codex resume naturally:
 *   codex exec resume <id> [flags...] -- prompt
 * And suppresses cwdFlag on resume (session already has a cwd).
 */
function buildFromConfig(config: HarnessConfig, options: BuildOptions): CommandSpec {
  const argv: string[] = [config.binary];
  const forking = options.fork === true && !!options.sessionId;
  const resuming = !forking && options.resume === true && !!options.sessionId;

  // Subcommand (e.g. 'exec' for codex)
  argv.push(...config.baseCmd);

  // Session fork/resume args go right after baseCmd.
  // Fork takes precedence — when native fork is unsupported, the caller is
  // expected to emulate with cp+resume before invoking buildCommand, so a
  // `fork: true` request on a non-fork-capable harness is an error.
  if (forking) {
    if (!config.sessionForkFlags) {
      throw new Error(
        `Harness "${config.binary}" does not natively support fork. ` +
        `Emulate via copy-and-resume (copy the on-disk session file to a ` +
        `new id, then buildCommand with { resume: true, sessionId: <copy> }).`
      );
    }
    argv.push(...config.sessionForkFlags(options.sessionId!));
  } else if (resuming && config.sessionResumeFlags) {
    argv.push(...config.sessionResumeFlags(options.sessionId!));
  }

  // Permissions bypass
  if (options.bypassPermissions) {
    argv.push(...config.bypassFlags);
  }

  // Working directory via CLI flag (only on first turn, not resume)
  if (!resuming && !forking && config.cwdFlag && options.cwd) {
    argv.push(config.cwdFlag, options.cwd);
  }

  // Model flags
  //
  // decomposeModel may already handle reasoning (e.g. codex composite IDs
  // like 'gpt-5.3-codex-high' decompose into -m + -c model_reasoning_effort=high).
  // Track whether decomposition produced effort flags so we don't double-add.
  let modelHandledReasoning = false;
  if (options.model) {
    if (config.decomposeModel) {
      const flags = config.decomposeModel(options.model);
      argv.push(...flags);
      // If decomposition produced -c flags, reasoning is already handled
      modelHandledReasoning = flags.some(f => f.startsWith('model_reasoning_effort='));
    } else {
      argv.push(config.modelFlag, options.model);
    }
  }

  // Standalone reasoning parameter (oompa passes reasoning separately).
  // Only applied if decomposeModel didn't already handle it.
  if (options.reasoning && !modelHandledReasoning && config.reasoningFlags) {
    argv.push(...config.reasoningFlags(options.reasoning));
  }

  // Session create flags (only when NOT resuming)
  if (!resuming && !forking && options.sessionId && config.sessionCreateFlags) {
    argv.push(...config.sessionCreateFlags(options.sessionId));
  }

  // Extra args from harness config
  if (config.extraArgs && config.extraArgs.length > 0) {
    argv.push(...config.extraArgs);
  }

  // Extra args from caller (project-specific flags)
  if (options.extraArgs && options.extraArgs.length > 0) {
    argv.push(...options.extraArgs);
  }

  // Prompt delivery
  //
  // If the harness expects the prompt via stdin, we do NOT append it to argv.
  // The caller is responsible for writing spec.prompt to stdin after spawn.
  if (options.prompt && config.stdin !== 'prompt') {
    switch (config.promptVia) {
      case 'flag':
        argv.push(config.promptFlag!, options.prompt);
        break;
      case 'cli-arg':
        argv.push(options.prompt);
        break;
      case 'cli-sep':
        argv.push(config.promptSep!, options.prompt);
        break;
    }
  }

  return {
    argv,
    stdin: config.stdin,
    stdout: config.stdout,
    prompt: options.prompt,
  };
}
