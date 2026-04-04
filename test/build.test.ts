import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand } from '../src/build.ts';
import { listHarnesses } from '../src/harnesses/index.ts';
import { resolveBinary } from '../src/resolve.ts';

// =============================================================================
// Claude
// =============================================================================

describe('claude', () => {
  it('creates session with --session-id on first turn', () => {
    const spec = buildCommand('claude', {
      model: 'opus',
      prompt: 'hello',
      sessionId: 'abc-123',
    });
    // Prompt NOT in argv because stdin is 'prompt'
    assert.deepStrictEqual(spec.argv, [
      'claude', '--model', 'opus', '--session-id', 'abc-123'
    ]);
    assert.strictEqual(spec.prompt, 'hello');
    assert.strictEqual(spec.stdin, 'prompt');
  });

  it('resumes with --resume <id>, NOT --session-id + --resume', () => {
    const spec = buildCommand('claude', {
      model: 'opus',
      prompt: 'continue',
      sessionId: 'abc-123',
      resume: true,
    });

    // The resume bug: --session-id must NOT appear when resuming.
    // Claude CLI rejects --session-id X --resume (without --fork-session).
    assert.ok(
      !spec.argv.includes('--session-id'),
      `--session-id must NOT appear in resume command. Got: ${JSON.stringify(spec.argv)}`
    );
    // Prompt NOT in argv because stdin is 'prompt'
    assert.deepStrictEqual(spec.argv, [
      'claude', '--resume', 'abc-123', '--model', 'opus'
    ]);
    assert.strictEqual(spec.prompt, 'continue');
  });

  it('includes bypass flags when requested', () => {
    const spec = buildCommand('claude', {
      prompt: 'test',
      bypassPermissions: true,
    });
    assert.ok(spec.argv.includes('--dangerously-skip-permissions'));
  });

  it('omits bypass flags when not requested', () => {
    const spec = buildCommand('claude', { prompt: 'test' });
    assert.ok(!spec.argv.includes('--dangerously-skip-permissions'));
  });

  it('stdin is prompt (Claude reads prompt from stdin)', () => {
    const spec = buildCommand('claude', { prompt: 'test' });
    assert.strictEqual(spec.stdin, 'prompt');
  });
});

// =============================================================================
// Codex
// =============================================================================

describe('codex', () => {
  it('builds first turn with exec, -C, and -- separator', () => {
    const spec = buildCommand('codex', {
      model: 'gpt-5.3-codex-high',
      prompt: 'hello',
      cwd: '/tmp/work',
    });
    assert.deepStrictEqual(spec.argv, [
      'codex', 'exec',
      '-C', '/tmp/work',
      '-m', 'gpt-5.3-codex', '-c', 'model_reasoning_effort=high',
      '--skip-git-repo-check',
      '--', 'hello',
    ]);
    assert.strictEqual(spec.stdin, 'close');
  });

  it('resume restructures command: exec resume <id>', () => {
    const spec = buildCommand('codex', {
      model: 'gpt-5.3-codex-high',
      prompt: 'continue',
      sessionId: 'thread-abc',
      resume: true,
    });
    // 'resume' and thread ID go right after 'exec'
    assert.strictEqual(spec.argv[0], 'codex');
    assert.strictEqual(spec.argv[1], 'exec');
    assert.strictEqual(spec.argv[2], 'resume');
    assert.strictEqual(spec.argv[3], 'thread-abc');
  });

  it('suppresses -C on resume', () => {
    const spec = buildCommand('codex', {
      model: 'gpt-5.3-codex',
      prompt: 'continue',
      sessionId: 'thread-abc',
      resume: true,
      cwd: '/tmp/work',
    });
    assert.ok(
      !spec.argv.includes('-C'),
      `-C must NOT appear in resume command. Got: ${JSON.stringify(spec.argv)}`
    );
  });

  it('decomposes composite model IDs', () => {
    const spec = buildCommand('codex', { model: 'gpt-5.3-codex-high', prompt: 'test' });
    const mIdx = spec.argv.indexOf('-m');
    assert.notStrictEqual(mIdx, -1);
    assert.strictEqual(spec.argv[mIdx + 1], 'gpt-5.3-codex');
    assert.ok(spec.argv.includes('-c'));
    assert.ok(spec.argv.includes('model_reasoning_effort=high'));
  });

  it('passes standalone models directly (no decomposition)', () => {
    const spec = buildCommand('codex', { model: 'gpt-5.3-codex-spark', prompt: 'test' });
    const mIdx = spec.argv.indexOf('-m');
    assert.strictEqual(spec.argv[mIdx + 1], 'gpt-5.3-codex-spark');
    assert.ok(!spec.argv.includes('-c'), 'standalone model should not have -c flag');
  });

  it('decomposes medium and xhigh effort levels', () => {
    for (const effort of ['medium', 'xhigh']) {
      const spec = buildCommand('codex', { model: `gpt-5.3-codex-${effort}`, prompt: 'test' });
      assert.ok(spec.argv.includes(`model_reasoning_effort=${effort}`), `missing effort for ${effort}`);
    }
  });

  it('includes bypass flags when requested', () => {
    const spec = buildCommand('codex', {
      prompt: 'test',
      bypassPermissions: true,
    });
    assert.ok(spec.argv.includes('--dangerously-bypass-approvals-and-sandbox'));
  });
});

// =============================================================================
// OpenCode
// =============================================================================

describe('opencode', () => {
  it('builds basic command with run subcommand and positional prompt', () => {
    const spec = buildCommand('opencode', {
      model: 'opencode/big-pickle',
      prompt: 'hello',
    });
    assert.deepStrictEqual(spec.argv, [
      'opencode', 'run', '-m', 'opencode/big-pickle', 'hello',
    ]);
    assert.strictEqual(spec.stdin, 'close');
  });

  it('emits resume flags only for ses_ prefixed IDs', () => {
    const spec = buildCommand('opencode', {
      prompt: 'continue',
      sessionId: 'ses_abc123',
      resume: true,
    });
    assert.ok(spec.argv.includes('--session'));
    assert.ok(spec.argv.includes('ses_abc123'));
    assert.ok(spec.argv.includes('--continue'));
  });

  it('skips resume flags for non-ses_ IDs', () => {
    const spec = buildCommand('opencode', {
      prompt: 'continue',
      sessionId: 'not-a-session',
      resume: true,
    });
    assert.ok(!spec.argv.includes('--session'));
    assert.ok(!spec.argv.includes('--continue'));
  });

  it('normalizes legacy openai/ model prefix to opencode/', () => {
    const spec = buildCommand('opencode', {
      model: 'openai/gpt-5',
      prompt: 'test',
    });
    const mIdx = spec.argv.indexOf('-m');
    assert.strictEqual(spec.argv[mIdx + 1], 'opencode/gpt-5');
  });

  it('passes opencode/ models through unchanged', () => {
    const spec = buildCommand('opencode', {
      model: 'opencode/big-pickle',
      prompt: 'test',
    });
    const mIdx = spec.argv.indexOf('-m');
    assert.strictEqual(spec.argv[mIdx + 1], 'opencode/big-pickle');
  });
});

// =============================================================================
// Gemini
// =============================================================================

describe('gemini', () => {
  it('builds basic command with -p flag and -m', () => {
    const spec = buildCommand('gemini', {
      model: 'gemini-2.5-pro',
      prompt: 'hello',
    });
    assert.deepStrictEqual(spec.argv, [
      'gemini', '-m', 'gemini-2.5-pro', '-p', 'hello',
    ]);
    assert.strictEqual(spec.stdin, 'close');
  });

  it('resume uses --resume with the provided sessionId', () => {
    const spec = buildCommand('gemini', {
      model: 'gemini-2.5-pro',
      prompt: 'continue',
      sessionId: 'my-session',
      resume: true,
    });
    assert.ok(spec.argv.includes('--resume'));
    assert.ok(spec.argv.includes('my-session'));
  });

  it('includes --yolo when bypass requested', () => {
    const spec = buildCommand('gemini', {
      prompt: 'test',
      bypassPermissions: true,
    });
    assert.ok(spec.argv.includes('--yolo'));
  });

  it('accepts arbitrary numbered aliases like gemini11', () => {
    const spec = buildCommand('gemini11', {
      model: 'gemini-2.5-pro',
      prompt: 'hello',
      sessionId: 'alias-session',
    });
    assert.deepStrictEqual(spec.argv, [
      'gemini11', '-m', 'gemini-2.5-pro', '-p', 'hello',
    ]);
    assert.strictEqual(spec.stdin, 'close');
  });

  it('accepts large numbered aliases like gemini99 and preserves resume target', () => {
    const spec = buildCommand('gemini99', {
      model: 'gemini-2.5-flash',
      prompt: 'continue',
      sessionId: 'sess-99',
      resume: true,
    });
    assert.strictEqual(spec.argv[0], 'gemini99');
    assert.ok(spec.argv.includes('--resume'));
    assert.ok(spec.argv.includes('sess-99'));
  });
});

// =============================================================================
// Real-world invocation patterns (from oompa + claude-web-view)
// =============================================================================

describe('oompa patterns', () => {
  it('worker loop: conversation with session + model + bypass + format flags', () => {
    const spec = buildCommand('claude', {
      model: 'opus',
      prompt: '[oompa:swarm-1:w0] implement task 001',
      sessionId: 'abc-123',
      bypassPermissions: true,
    });
    assert.ok(spec.argv.includes('--dangerously-skip-permissions'));
    assert.ok(spec.argv.includes('--session-id'));
    // Prompt NOT in argv because stdin is 'prompt'
    assert.ok(!spec.argv.includes('-p'));
    assert.strictEqual(spec.prompt, '[oompa:swarm-1:w0] implement task 001');
    assert.strictEqual(spec.stdin, 'prompt');
  });

  it('worker resume: carries session forward', () => {
    const spec = buildCommand('claude', {
      model: 'opus',
      prompt: '[oompa:swarm-1:w0] continue working',
      sessionId: 'abc-123',
      resume: true,
      bypassPermissions: true,
    });
    assert.ok(!spec.argv.includes('--session-id'), 'must not combine --session-id with resume');
    assert.ok(spec.argv.includes('--resume'));
    assert.ok(spec.argv.includes('abc-123'));
    // Prompt NOT in argv
    assert.ok(!spec.argv.includes('-p'));
  });

  it('reviewer: single-shot, no session, no bypass', () => {
    const spec = buildCommand('claude', {
      model: 'opus',
      prompt: '[oompa:swarm-1:w0] VERDICT review prompt...',
    });
    assert.ok(!spec.argv.includes('--session-id'));
    assert.ok(!spec.argv.includes('--resume'));
    assert.ok(!spec.argv.includes('--dangerously-skip-permissions'));
    // Prompt NOT in argv
    assert.deepStrictEqual(spec.argv, ['claude', '--model', 'opus']);
    assert.strictEqual(spec.prompt, '[oompa:swarm-1:w0] VERDICT review prompt...');
  });

  it('planner: single-shot with bypass', () => {
    const spec = buildCommand('codex', {
      model: 'gpt-5.3-codex-high',
      prompt: 'plan tasks for the sprint',
      cwd: '/home/user/project',
      bypassPermissions: true,
    });
    assert.ok(spec.argv.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(spec.argv.includes('-C'));
    assert.ok(!spec.argv.includes('resume'));
  });

  it('codex worker with bypass includes --skip-git-repo-check', () => {
    const spec = buildCommand('codex', {
      model: 'gpt-5.3-codex-high',
      prompt: 'implement feature',
      cwd: '/tmp/worktree',
      bypassPermissions: true,
    });
    // --skip-git-repo-check is in codex bypassFlags (needed for worktrees)
    assert.ok(spec.argv.includes('--skip-git-repo-check'));
    // It must come BEFORE the -- separator (it's a flag, not a positional arg)
    const sepIdx = spec.argv.indexOf('--');
    const flagIdx = spec.argv.indexOf('--skip-git-repo-check');
    assert.ok(flagIdx < sepIdx, `--skip-git-repo-check must be before -- separator`);
  });
});

describe('claude-web-view patterns', () => {
  it('conversation mode: full streaming config via extraArgs', () => {
    const spec = buildCommand('claude', {
      model: 'opus',
      prompt: 'hello',
      sessionId: 'conv-uuid',
      bypassPermissions: true,
      extraArgs: [
        '-p', '--verbose',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--permission-mode', 'bypassPermissions',
        '--tools', 'default',
        '--add-dir', '/Users/nick/project',
      ],
    });
    assert.ok(spec.argv.includes('--output-format'));
    assert.ok(spec.argv.includes('stream-json'));
    assert.ok(spec.argv.includes('--include-partial-messages'));
    assert.ok(spec.argv.includes('--add-dir'));
  });

  it('single-shot palette generation: minimal flags', () => {
    const spec = buildCommand('claude', {
      prompt: 'generate a dark theme palette',
      extraArgs: ['--output-format', 'text'],
    });
    // No session, no bypass, just prompt + output format
    assert.ok(!spec.argv.includes('--session-id'));
    assert.ok(!spec.argv.includes('--resume'));
    assert.ok(!spec.argv.includes('--dangerously-skip-permissions'));
    assert.ok(spec.argv.includes('--output-format'));
    assert.ok(spec.argv.includes('text'));
  });

  it('codex conversation with stdin delivery via extraArgs', () => {
    // claude-web-view uses `-` as positional arg to tell codex to read from stdin
    const spec = buildCommand('codex', {
      model: 'gpt-5.3-codex-high',
      cwd: '/Users/nick/project',
      bypassPermissions: true,
      // No prompt in argv — delivered via stdin. `-` tells codex to read stdin.
      extraArgs: ['--json', '-'],
    });
    assert.ok(spec.argv.includes('--json'));
    assert.ok(spec.argv.includes('-'));
    // No `--` separator since no prompt was provided
    assert.ok(!spec.argv.includes('--'));
  });

  it('codex resume with stdin delivery', () => {
    const spec = buildCommand('codex', {
      model: 'gpt-5.3-codex-high',
      sessionId: 'thread-abc',
      resume: true,
      bypassPermissions: true,
      extraArgs: ['--json', '-'],
    });
    // exec resume <id> structure
    assert.strictEqual(spec.argv[1], 'exec');
    assert.strictEqual(spec.argv[2], 'resume');
    assert.strictEqual(spec.argv[3], 'thread-abc');
    // No -C on resume
    assert.ok(!spec.argv.includes('-C'));
    // Has --json and - from extraArgs
    assert.ok(spec.argv.includes('--json'));
    assert.ok(spec.argv.includes('-'));
  });

  it('opencode conversation with format flag', () => {
    const spec = buildCommand('opencode', {
      model: 'opencode/big-pickle',
      prompt: 'hello',
      extraArgs: ['--format', 'json'],
    });
    assert.ok(spec.argv.includes('--format'));
    assert.ok(spec.argv.includes('json'));
  });

  it('opencode single-shot: no format flags', () => {
    const spec = buildCommand('opencode', {
      prompt: 'summarize this',
    });
    assert.ok(!spec.argv.includes('--format'));
    assert.deepStrictEqual(spec.argv, ['opencode', 'run', 'summarize this']);
  });
});

// =============================================================================
// Cross-cutting concerns
// =============================================================================

describe('cross-cutting', () => {
  it('extraArgs are appended after all generated flags', () => {
    const spec = buildCommand('claude', {
      prompt: 'test',
      extraArgs: ['--output-format', 'stream-json', '--verbose'],
    });
    const lastGeneratedIdx = spec.argv.indexOf('test');
    const extraStartIdx = spec.argv.indexOf('--output-format');
    assert.ok(
      extraStartIdx > lastGeneratedIdx,
      'extraArgs must come after prompt'
    );
  });

  it('prompt field is included in CommandSpec', () => {
    const spec = buildCommand('claude', { prompt: 'hello world' });
    assert.strictEqual(spec.prompt, 'hello world');
  });

  it('works with no options', () => {
    const spec = buildCommand('claude', {});
    assert.deepStrictEqual(spec.argv, ['claude']);
  });

  it('throws on unknown harness', () => {
    assert.throws(
      () => buildCommand('unknown-harness', {}),
      /Unknown harness/,
    );
  });

  it('listHarnesses returns all five', () => {
    const harnesses = listHarnesses();
    assert.deepStrictEqual(harnesses.sort(), ['claude', 'codex', 'cursor', 'gemini', 'opencode']);
  });
});

// =============================================================================
// Reasoning / effort
// =============================================================================

describe('reasoning', () => {
  it('standalone reasoning adds -c flag for codex', () => {
    const spec = buildCommand('codex', {
      model: 'gpt-5.3-codex',
      prompt: 'test',
      reasoning: 'high',
    });
    assert.ok(spec.argv.includes('-c'));
    assert.ok(spec.argv.includes('model_reasoning_effort=high'));
  });

  it('does NOT double-add reasoning when composite ID already encodes it', () => {
    const spec = buildCommand('codex', {
      model: 'gpt-5.3-codex-high',
      prompt: 'test',
      reasoning: 'high',  // should be ignored — model ID already has effort
    });
    const cFlags = spec.argv.filter(f => f.startsWith('model_reasoning_effort='));
    assert.strictEqual(cFlags.length, 1, `expected 1 reasoning flag, got ${cFlags.length}: ${JSON.stringify(spec.argv)}`);
  });

  it('standalone reasoning works for all effort levels', () => {
    for (const level of ['minimal', 'low', 'medium', 'high', 'max', 'xhigh']) {
      const spec = buildCommand('codex', {
        model: 'gpt-5.3-codex',
        prompt: 'test',
        reasoning: level,
      });
      assert.ok(spec.argv.includes(`model_reasoning_effort=${level}`), `missing effort for ${level}`);
    }
  });

  it('reasoning is ignored for non-codex harnesses', () => {
    const spec = buildCommand('claude', {
      model: 'opus',
      prompt: 'test',
      reasoning: 'high',  // Claude doesn't support reasoning
    });
    assert.ok(!spec.argv.includes('-c'));
    assert.ok(!spec.argv.some(f => f.includes('reasoning')));
  });
});

// =============================================================================
// Model loop: every known model ID produces valid commands
// =============================================================================

describe('model loop', () => {
  // All known model IDs from both codebases
  const ALL_MODELS: Record<string, string[]> = {
    claude: ['opus', 'sonnet', 'haiku'],
    codex: [
      'gpt-5.3-codex-high',
      'gpt-5.3-codex-medium',
      'gpt-5.3-codex-xhigh',
      'gpt-5.3-codex-spark',
      'gpt-5.3-codex-spark-high',
      'gpt-5.3-codex-spark-medium',
      'gpt-5.3-codex-spark-xhigh',
    ],
    opencode: [
      'opencode/big-pickle',
      'opencode/gpt-5-nano',
      'opencode/kimi-k2.5-free',
      'opencode/minimax-m2.5-free',
      'openai/gpt-5',  // legacy format
    ],
    gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  };

  for (const [harness, models] of Object.entries(ALL_MODELS)) {
    for (const model of models) {
      it(`${harness}/${model}: builds valid create command`, () => {
        const spec = buildCommand(harness, {
          model,
          prompt: 'test prompt',
          sessionId: 'test-session',
          bypassPermissions: true,
        });
        // Basic sanity: argv starts with the binary
        assert.strictEqual(spec.argv[0], harness === 'codex' ? 'codex' : harness);
        // Model appears in argv (either directly, decomposed, or normalized).
        // OpenCode normalizes openai/X → opencode/X, so check both forms.
        const normalized = model.replace(/^openai\//, 'opencode/');
        const hasModel = spec.argv.some(a =>
          a.includes(model) ||
          a.includes(normalized) ||
          a.includes(model.split('-').slice(0, -1).join('-'))
        );
        assert.ok(hasModel, `model "${model}" (or normalized "${normalized}") not found in argv: ${JSON.stringify(spec.argv)}`);
      });

      it(`${harness}/${model}: builds valid resume command`, () => {
        const spec = buildCommand(harness, {
          model,
          prompt: 'continue',
          sessionId: 'test-session',
          resume: true,
        });
        assert.strictEqual(spec.argv[0], harness === 'codex' ? 'codex' : harness);
        // No session-create flags in resume
        assert.ok(!spec.argv.includes('--session-id'), `--session-id should not appear in resume for ${harness}/${model}`);
      });
    }
  }

  // Codex models with separate reasoning param (oompa style)
  const CODEX_BASE_MODELS = ['gpt-5.3-codex', 'gpt-5.3-codex-spark'];
  const REASONING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  for (const model of CODEX_BASE_MODELS) {
    for (const reasoning of REASONING_LEVELS) {
      it(`codex/${model} + reasoning=${reasoning}: adds effort flag`, () => {
        const spec = buildCommand('codex', {
          model,
          prompt: 'test',
          reasoning,
        });
        assert.ok(
          spec.argv.includes(`model_reasoning_effort=${reasoning}`),
          `missing model_reasoning_effort=${reasoning} for ${model}: ${JSON.stringify(spec.argv)}`
        );
      });
    }
  }
});

// =============================================================================
// JSON input mode — tested via buildCommand directly (same codepath, no CLI spawn)
// =============================================================================

describe('json input', () => {
  it('resume produces correct command (no --session-id)', () => {
    const spec = buildCommand('claude', { model: 'opus', prompt: 'continue', sessionId: 'abc-123', resume: true });
    assert.ok(!spec.argv.includes('--session-id'));
    assert.ok(spec.argv.includes('--resume'));
    assert.ok(spec.argv.includes('abc-123'));
  });

  it('extraArgs are threaded through', () => {
    const spec = buildCommand('claude', { prompt: 'hello', extraArgs: ['--output-format', 'stream-json'] });
    assert.ok(spec.argv.includes('--output-format'));
    assert.ok(spec.argv.includes('stream-json'));
  });

  it('codex model decomposition with bypass', () => {
    const spec = buildCommand('codex', { model: 'gpt-5.3-codex-high', prompt: 'fix bug', bypassPermissions: true });
    assert.ok(spec.argv.includes('-m'));
    assert.ok(spec.argv.includes('gpt-5.3-codex'));
    assert.ok(spec.argv.includes('model_reasoning_effort=high'));
    assert.ok(spec.argv.includes('--dangerously-bypass-approvals-and-sandbox'));
  });

  it('gemini alias harness (gemini11) produces correct binary', () => {
    const spec = buildCommand('gemini11', { model: 'gemini-2.5-pro', prompt: 'hello' });
    assert.strictEqual(spec.argv[0], 'gemini11');
    assert.ok(spec.argv.includes('-m'));
    assert.ok(spec.argv.includes('gemini-2.5-pro'));
  });
});

// =============================================================================
// Binary resolution (--resolve flag, resolveBinary library)
// =============================================================================

describe('resolve', () => {
  it('resolveBinary returns absolute path for a binary on PATH', () => {
    const path = resolveBinary('node');
    assert.ok(path.startsWith('/'), `expected absolute path, got: ${path}`);
    assert.ok(path.includes('node'));
  });

  it('resolveBinary throws for unknown binary', () => {
    assert.throws(
      () => resolveBinary('nonexistent-binary-that-does-not-exist-12345'),
      /Binary not found on PATH/,
    );
  });
});
