#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { buildCommand } from './build.ts';
import {
  executeCommand,
  type ExecuteCommandRequest,
  type CodexReasoningLevel,
  type ClaudeReasoningLevel,
} from './run.ts';
import { listHarnesses, getHarness, canonicalizeHarness } from './harnesses/index.ts';
import { resolveBinary } from './resolve.ts';
import type { BuildOptions, HarnessName } from './types.ts';

const USAGE = `agent-cli — Shared CLI agent invocation tool

Usage:
  agent-cli run --harness <name> [options]      Run an agent CLI (primary interface)
  agent-cli build --harness <name> [options]    Build a command (JSON to stdout, for debugging)
  agent-cli check <harness>                     Check if a harness binary is available
  agent-cli list                                List available harnesses
  agent-cli info <harness>                      Show harness details

Options:
  --harness <name>         Agent CLI to invoke (claude, codex, opencode, gemini, cursor, gemini1, gemini2, gemini3)
  --model <id>             Model identifier (harness-specific)
  --prompt <text>          Prompt text
  --session <id>           Session ID (for create or resume)
  --resume                 Resume an existing session (vs create new)
  --cwd <path>             Working directory for the agent process
  --bypass-permissions     Include permissions bypass flags
  --debug-events           Mirror raw provider stdout/stderr to stderr during run
  --reasoning <level>      Reasoning effort level. codex: minimal|low|medium|high|xhigh|max. claude: low|medium|high|xhigh|max.
  --resolve                Resolve binary in argv[0] to absolute path (build only)
  --input <json|->         JSON input (inline or stdin). Shape: { harness, model?, prompt?, ... }
  --extra <args...>        Extra args appended after all generated args (must be last)`;

function parseArgs(args: string[]): Record<string, string | boolean | string[]> {
  const result: Record<string, string | boolean | string[]> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--extra') {
      result.extra = args.slice(i + 1);
      break;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        result[key] = true;
        i++;
      } else {
        result[key] = next;
        i += 2;
      }
    } else {
      result._positional = arg;
      i++;
    }
  }
  return result;
}

/**
 * Parse build options from CLI flags or JSON input.
 *
 * Two modes:
 * 1. Flag mode: --harness claude --model opus --prompt "hi" ...
 * 2. JSON mode: --input '{"harness":"claude","model":"opus"}' or --input - (stdin)
 *
 * JSON shape matches BuildOptions + { harness: string } at top level.
 */
function parseBuildOptions(rest: string[]): { harness: string; options: BuildOptions; resolve: boolean } {
  const opts = parseArgs(rest);

  // JSON input mode: --input '{"harness":...}' or --input - (stdin)
  if (opts.input !== undefined) {
    const raw = opts.input === '-'
      ? readFileSync(0, 'utf-8')  // fd 0 = stdin
      : opts.input as string;

    const json = JSON.parse(raw);
    const harness = json.harness as string;
    if (!harness) {
      console.error('Error: JSON input must include "harness" field\n');
      process.exit(1);
    }

    return {
      harness,
      options: {
        model: json.model,
        prompt: json.prompt,
        sessionId: json.sessionId,
        resume: json.resume === true,
        cwd: json.cwd,
        bypassPermissions: json.bypassPermissions === true,
        reasoning: json.reasoning,
        extraArgs: json.extraArgs,
      },
      resolve: opts.resolve === true,
    };
  }

  // Flag mode (original behavior)
  const harness = opts.harness as string | undefined;
  if (!harness) {
    console.error('Error: --harness is required (or use --input for JSON mode)\n');
    console.error(USAGE);
    process.exit(1);
  }
  return {
    harness,
    options: {
      model: opts.model as string | undefined,
      prompt: opts.prompt as string | undefined,
      sessionId: opts.session as string | undefined,
      resume: opts.resume === true,
      cwd: opts.cwd as string | undefined,
      bypassPermissions: opts['bypass-permissions'] === true,
      reasoning: opts.reasoning as string | undefined,
      extraArgs: opts.extra as string[] | undefined,
    },
    resolve: opts.resolve === true,
  };
}

function parseRunRequest(rest: string[]): ExecuteCommandRequest {
  const opts = parseArgs(rest);
  const debugRawEvents = opts['debug-events'] === true || process.env.AGENT_CLI_DEBUG_EVENTS === '1';

  if (opts.input !== undefined) {
    const raw = opts.input === '-'
      ? readFileSync(0, 'utf-8')
      : opts.input as string;
    const parsed = JSON.parse(raw) as ExecuteCommandRequest;
    return debugRawEvents ? { ...parsed, debugRawEvents: true } : parsed;
  }

  const harness = opts.harness as string | undefined;
  if (!harness) {
    console.error('Error: --harness is required (or use --input for JSON mode)\n');
    console.error(USAGE);
    process.exit(1);
  }

  const harnessName = harness as HarnessName;
  const base = {
    harness: harnessName,
    mode: 'conversation' as const,
    prompt: (opts.prompt as string | undefined) ?? '',
    cwd: (opts.cwd as string | undefined) ?? process.cwd(),
    model: opts.model as string | undefined,
    extraArgs: opts.extra as string[] | undefined,
    yolo: opts['bypass-permissions'] === true,
    ...(debugRawEvents ? { debugRawEvents: true } : {}),
    ...(opts.session ? { sessionId: opts.session as string } : {}),
    ...(opts.resume && opts.session ? { resumeSessionId: opts.session as string } : {}),
  };

  const canonical = canonicalizeHarness(harnessName);
  if (canonical === 'codex') {
    return {
      ...base,
      harness: 'codex',
      ...(opts.reasoning ? { reasoningEffort: opts.reasoning as CodexReasoningLevel } : {}),
    };
  }
  if (canonical === 'claude') {
    return {
      ...base,
      harness: 'claude',
      ...(opts.reasoning ? { reasoningEffort: opts.reasoning as ClaudeReasoningLevel } : {}),
    };
  }

  return base as ExecuteCommandRequest;
}

function exitCodeForReason(reason: string, childExitCode: number | null): number {
  switch (reason) {
    case 'success':
      return childExitCode ?? 0;
    case 'out_of_tokens':
      return 2;
    case 'error':
      return 3;
    case 'killed':
      return 130;
    default:
      return childExitCode ?? 1;
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.error(USAGE);
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case 'run': {
      const request = parseRunRequest(rest);
      const handle = executeCommand(request);

      // Stdin EOF lifecycle: when our parent dies (for any reason, including
      // SIGKILL), the kernel closes its FDs and our stdin gets EOF. Treat
      // this as "parent is gone" and kill the entire child process group.
      // Only active in piped mode — interactive TTY use is unaffected.
      if (!process.stdin.isTTY) {
        process.stdin.on('end', () => {
          const pid = handle.child.pid;
          if (pid != null && handle.child.exitCode === null) {
            try { process.kill(-pid, 'SIGTERM'); } catch {}
            setTimeout(() => {
              try { process.kill(-pid, 'SIGKILL'); } catch {}
            }, 3000);
          }
        });
        process.stdin.resume();
      }

      for await (const event of handle.events) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      }

      const completion = await handle.completed;
      process.exit(exitCodeForReason(completion.reason, completion.exitCode));
      break;
    }

    case 'build': {
      const { harness, options, resolve } = parseBuildOptions(rest);
      const spec = buildCommand(harness, options);

      // --resolve: replace bare binary name with absolute path
      if (resolve && spec.argv.length > 0) {
        spec.argv[0] = resolveBinary(spec.argv[0]);
      }

      console.log(JSON.stringify(spec));
      break;
    }

    case 'check': {
      const name = rest[0];
      if (!name) {
        console.error('Error: harness name required');
        process.exit(1);
      }
      const config = getHarness(name);
      try {
        const path = resolveBinary(config.binary);
        console.log(JSON.stringify({ available: true, binary: config.binary, path }));
      } catch {
        console.log(JSON.stringify({ available: false, binary: config.binary, path: null }));
      }
      break;
    }

    case 'list': {
      console.log(JSON.stringify(listHarnesses()));
      break;
    }

    case 'info': {
      const name = rest[0];
      if (!name) {
        console.error('Error: harness name required');
        process.exit(1);
      }
      const config = getHarness(name);
      console.log(JSON.stringify({
        binary: config.binary,
        baseCmd: config.baseCmd,
        modelFlag: config.modelFlag,
        promptVia: config.promptVia,
        stdin: config.stdin,
        cwdFlag: config.cwdFlag ?? null,
        bypassFlags: config.bypassFlags,
      }, null, 2));
      break;
    }

    default: {
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
