#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const runsRoot = path.join(__dirname, 'runs');
const HIDE_TEST_PREFIX = '[_HIDE_TEST_]';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }
  return options;
}

function usage() {
  return `manual harness capture

Usage:
  node manual_tests/capture-live-run.mjs [options]

Options:
  --runner <raw|shared>         Run the harness directly or through agent-cli. Default: raw
  --harness <codex|claude>      Harness to probe. Default: codex
  --scenario <name>             Built-in prompt scenario. Default: subagents
  --model <id>                  Model override
  --cwd <path>                  Working directory passed to the harness. Default: current cwd
  --timeout-ms <n>              Kill the run after N ms. Default: 240000
  --out-dir <path>              Base output directory. Default: manual_tests/runs/<timestamp>-...
  --prompt <text>               Inline prompt override
  --prompt-file <path>          Prompt file override
  --no-hide-test-prefix         Do not prepend [_HIDE_TEST_] to the prompt
  --no-debug-events             Shared runner only: disable raw-provider mirror logs
  --help                        Show this message
`;
}

function formatTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function buildCodexSubagentPrompt(outputDir) {
  return [
    'Use the spawn_agent tool exactly three times.',
    'Spawn all three sub-agents before waiting for any of them.',
    'Each sub-agent must write exactly one file with exactly one line of text:',
    `- ${path.join(outputDir, 'file_1.md')}`,
    `- ${path.join(outputDir, 'file_2.md')}`,
    `- ${path.join(outputDir, 'file_3.md')}`,
    'The file content must be exactly: test-confirmed',
    'Do not write any of these files from the main agent.',
    'After spawning them, wait for all three sub-agents to finish.',
    'After they finish, verify that all three files exist.',
    'When done, reply with exactly SUBAGENTS_OK and nothing else.',
  ].join('\n');
}

function buildClaudeSubagentPrompt(outputDir) {
  return [
    'Use the Task tool exactly three times.',
    'Launch all three Task sub-agents before using any non-Task tool.',
    'Each sub-agent must own exactly one file and write exactly one line of text:',
    `- ${path.join(outputDir, 'file_1.md')}`,
    `- ${path.join(outputDir, 'file_2.md')}`,
    `- ${path.join(outputDir, 'file_3.md')}`,
    'The file content must be exactly: test-confirmed',
    'The main agent must not write those files itself.',
    'After all three Task sub-agents finish, verify the files exist.',
    'Then reply with exactly SUBAGENTS_OK and nothing else.',
  ].join('\n');
}

const scenarios = {
  subagents: {
    codex: buildCodexSubagentPrompt,
    claude: buildClaudeSubagentPrompt,
  },
};

function defaultModelFor(harness) {
  switch (harness) {
    case 'claude':
      return process.env.MANUAL_TEST_CLAUDE_MODEL ?? 'sonnet';
    case 'codex':
      return process.env.MANUAL_TEST_CODEX_MODEL ?? 'gpt-5.4-mini';
    default:
      throw new Error(`Unsupported harness: ${harness}`);
  }
}

function rawCommandFor({ harness, cwd, model, prompt }) {
  switch (harness) {
    case 'codex':
      return {
        command: 'codex',
        args: [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          '-C',
          cwd,
          '-m',
          model,
          '--',
          prompt,
        ],
        stdinPayload: null,
        metadata: {
          mode: 'raw',
          harness,
          cwd,
          model,
        },
      };
    case 'claude':
      return {
        command: 'claude',
        args: [
          '--dangerously-skip-permissions',
          '--model',
          model,
          '-p',
          '--verbose',
          '--output-format',
          'stream-json',
          '--include-partial-messages',
          '--permission-mode',
          'bypassPermissions',
          '--tools',
          'default',
          '--add-dir',
          cwd,
        ],
        stdinPayload: prompt,
        metadata: {
          mode: 'raw',
          harness,
          cwd,
          model,
          stdin: 'prompt',
        },
      };
    default:
      throw new Error(`Unsupported raw harness: ${harness}`);
  }
}

function sharedCommandFor({ harness, cwd, model, prompt, debugRawEvents }) {
  const request = {
    harness,
    mode: 'conversation',
    prompt,
    cwd,
    model,
    yolo: true,
    ...(debugRawEvents ? { debugRawEvents: true } : {}),
  };

  return {
    command: process.execPath,
    args: [
      '--experimental-strip-types',
      path.join(packageRoot, 'src', 'cli.ts'),
      'run',
      '--input',
      '-',
    ],
    stdinPayload: JSON.stringify(request),
    metadata: request,
  };
}

function buildInvocation(options) {
  if (options.runner === 'raw') {
    return rawCommandFor(options);
  }
  if (options.runner === 'shared') {
    return sharedCommandFor(options);
  }
  throw new Error(`Unsupported runner: ${options.runner}`);
}

function collectFileStatuses(outputDir) {
  return [1, 2, 3].map((index) => {
    const filePath = path.join(outputDir, `file_${index}.md`);
    try {
      return {
        filePath,
        exists: true,
        content: fs.readFileSync(filePath, 'utf8').trim(),
      };
    } catch {
      return {
        filePath,
        exists: false,
        content: null,
      };
    }
  });
}

function countJsonEventTypes(text) {
  const counts = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.type === 'string') {
        counts[parsed.type] = (counts[parsed.type] ?? 0) + 1;
      }
    } catch {}
  }
  return counts;
}

function ensureHideTestPrefix(prompt) {
  const trimmed = prompt.trimStart();
  if (trimmed.startsWith(HIDE_TEST_PREFIX)) {
    return prompt;
  }
  return `${HIDE_TEST_PREFIX}\n${prompt}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    process.exit(0);
  }

  const runner = args.runner ?? 'raw';
  const harness = args.harness ?? 'codex';
  const scenario = args.scenario ?? 'subagents';
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const model = args.model ?? defaultModelFor(harness);
  const timeoutMs = Number(args['timeout-ms'] ?? 240000);
  const debugRawEvents = !args['no-debug-events'];

  const runDir = args['out-dir']
    ? path.resolve(args['out-dir'])
    : path.join(runsRoot, `${formatTimestamp()}-${runner}-${harness}-${scenario}`);
  const outputDir = path.join(runDir, 'artifacts', randomUUID());

  fs.mkdirSync(outputDir, { recursive: true });

  let prompt =
    typeof args.prompt === 'string'
      ? args.prompt
      : typeof args['prompt-file'] === 'string'
        ? fs.readFileSync(path.resolve(args['prompt-file']), 'utf8')
        : scenarios[scenario]?.[harness]?.(outputDir);

  if (!prompt) {
    throw new Error(
      `No prompt available for scenario=${scenario} harness=${harness}. Use --prompt or --prompt-file.`
    );
  }

  if (!args['no-hide-test-prefix']) {
    prompt = ensureHideTestPrefix(prompt);
  }

  const invocation = buildInvocation({
    runner,
    harness,
    scenario,
    cwd,
    model,
    prompt,
    debugRawEvents,
  });

  const logPath = path.join(runDir, 'run.log');
  const stdoutPath = path.join(runDir, 'stdout.log');
  const stderrPath = path.join(runDir, 'stderr.log');
  const summaryPath = path.join(runDir, 'summary.json');
  const promptPath = path.join(runDir, 'prompt.txt');
  const commandPath = path.join(runDir, 'command.json');

  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(promptPath, prompt);
  fs.writeFileSync(
    commandPath,
    JSON.stringify(
      {
        runner,
        harness,
        scenario,
        cwd,
        model,
        timeoutMs,
        command: invocation.command,
        args: invocation.args,
        metadata: invocation.metadata,
      },
      null,
      2
    )
  );

  const combinedLog = fs.createWriteStream(logPath, { flags: 'a' });
  const stdoutLog = fs.createWriteStream(stdoutPath, { flags: 'a' });
  const stderrLog = fs.createWriteStream(stderrPath, { flags: 'a' });

  const writeCombined = (prefix, text) => {
    combinedLog.write(`${prefix} ${text}`);
    if (!text.endsWith('\n')) combinedLog.write('\n');
  };

  writeCombined('#', `started ${new Date().toISOString()}`);
  writeCombined('#', `runner ${runner}`);
  writeCombined('#', `harness ${harness}`);
  writeCombined('#', `scenario ${scenario}`);
  writeCombined('#', `cwd ${cwd}`);
  writeCombined('#', `output_dir ${outputDir}`);
  writeCombined('#', `model ${model}`);
  writeCombined('#', `timeout_ms ${timeoutMs}`);
  writeCombined('#', `command ${JSON.stringify([invocation.command, ...invocation.args])}`);

  const child = spawn(invocation.command, invocation.args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: process.env,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    stdoutLog.write(text);
    writeCombined('[stdout]', text);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderr += text;
    stderrLog.write(text);
    writeCombined('[stderr]', text);
  });

  child.on('error', (err) => {
    writeCombined('#', `spawn_error ${err.stack ?? err.message}`);
  });

  if (invocation.stdinPayload) {
    child.stdin.end(invocation.stdinPayload);
  } else {
    child.stdin.end();
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    writeCombined('#', `timeout_reached after ${timeoutMs}ms`);
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, 3000).unref();
  }, timeoutMs);

  child.on('close', (code, signal) => {
    clearTimeout(timeout);

    const summary = {
      runDir,
      logPath,
      stdoutPath,
      stderrPath,
      summaryPath,
      promptPath,
      commandPath,
      outputDir,
      runner,
      harness,
      scenario,
      cwd,
      model,
      exitCode: code,
      signal,
      timedOut,
      files: collectFileStatuses(outputDir),
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stdoutEventTypes: countJsonEventTypes(stdout),
    };

    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    writeCombined('#', `exit code=${code} signal=${signal} timedOut=${timedOut}`);
    writeCombined('#', `files ${JSON.stringify(summary.files)}`);

    stdoutLog.end();
    stderrLog.end();
    combinedLog.end(() => {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    });
  });
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
