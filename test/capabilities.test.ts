import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { turnCommand } from '../src/execute.ts';
import { capabilityReport } from '../src/harnesses/index.ts';
import type { ExecuteCommandRequest } from '../src/runtime-types.ts';
import type { CapabilityReport, TurnCapabilities } from '../src/types.ts';

// Turn capabilities (types.ts `TurnCapabilities`): the argv each harness builds for a capability
// set, the enforced/advisory report, and the guarantee that a request WITHOUT a set builds exactly
// the argv it built before sets existed. Origin: the first real expedition run (2026-11-11) ran a
// tool-less "call" turn with Claude `--tools default` + bypassPermissions and Codex
// `danger-full-access`, and both loaded the owner's global instructions.

const HTTP = {
  kind: 'http',
  url: 'http://127.0.0.1:9/mcp',
  headers: { Authorization: 'Bearer t0k' },
  required: true,
} as const;

// Captured from executeCommand(...).spec.argv at ef0ebb0, BEFORE capability sets existed.
// A diff here changes every ordinary Buddy, chat and swarm turn.
const BEFORE: ReadonlyArray<readonly [string, ExecuteCommandRequest, readonly string[]]> = [
  [
    'claude Buddy turn',
    {
      harness: 'claude',
      mode: 'conversation',
      prompt: 'hi',
      cwd: '/w',
      model: 'claude-opus-5-5',
      sessionId: '11111111-1111-1111-1111-111111111111',
      yolo: true,
      reasoningEffort: 'high',
      mcpServers: { unleashd_buddy: HTTP },
      extraArgs: ['--settings', '{"autoMemoryEnabled":false}'],
    },
    [
      'claude',
      '--dangerously-skip-permissions',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'high',
      '--session-id',
      '11111111-1111-1111-1111-111111111111',
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
      '/w',
      '--settings',
      '{"autoMemoryEnabled":false}',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{"unleashd_buddy":{"type":"http","url":"http://127.0.0.1:9/mcp","headers":{"Authorization":"${AGENT_CLI_MCP_UNLEASHD_BUDDY__AUTHORIZATION}"}}}}',
    ],
  ],
  [
    'claude chat resume',
    {
      harness: 'claude',
      mode: 'conversation',
      prompt: 'hi',
      cwd: '/w',
      model: 'opus',
      resumeSessionId: '22222222-2222-2222-2222-222222222222',
    },
    [
      'claude',
      '--resume',
      '22222222-2222-2222-2222-222222222222',
      '--dangerously-skip-permissions',
      '--model',
      'opus',
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
      '/w',
    ],
  ],
  [
    'claude without yolo',
    { harness: 'claude', mode: 'conversation', prompt: 'hi', cwd: '/w', yolo: false },
    ['claude', '-p', '--verbose', '--output-format', 'stream-json', '--include-partial-messages'],
  ],
  [
    'codex Buddy turn',
    {
      harness: 'codex',
      mode: 'conversation',
      prompt: 'hi',
      cwd: '/w',
      model: 'gpt-6.1-sol',
      yolo: true,
      reasoningEffort: 'xhigh',
      mcpServers: { unleashd_buddy: HTTP },
      extraArgs: ['-c', 'features.hooks=true'],
    },
    [
      'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      '/w',
      '-m',
      'gpt-6.1-sol',
      '-c',
      'model_reasoning_effort=xhigh',
      '--skip-git-repo-check',
      '--json',
      '-c',
      'features.hooks=true',
      '-c',
      'mcp_servers.unleashd_buddy.url="http://127.0.0.1:9/mcp"',
      '-c',
      'mcp_servers.unleashd_buddy.enabled=true',
      '-c',
      'mcp_servers.unleashd_buddy.required=true',
      '-c',
      'mcp_servers.unleashd_buddy.env_http_headers={"Authorization"="AGENT_CLI_MCP_UNLEASHD_BUDDY__AUTHORIZATION"}',
      '-',
    ],
  ],
  [
    'codex fullAuto + webSearch resume',
    {
      harness: 'codex',
      mode: 'conversation',
      prompt: 'hi',
      cwd: '/w',
      fullAuto: true,
      webSearch: true,
      resumeSessionId: 'thread-1',
    },
    [
      'codex',
      'exec',
      'resume',
      'thread-1',
      '--skip-git-repo-check',
      '-s',
      'workspace-write',
      '-c',
      'tools.web_search=true',
      '--json',
      '-',
    ],
  ],
  [
    'codex single-shot',
    { harness: 'codex', mode: 'single-shot', prompt: 'hi', cwd: '/w' },
    [
      'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      '/w',
      '--skip-git-repo-check',
      '-',
    ],
  ],
  [
    'opencode',
    { harness: 'opencode', mode: 'conversation', prompt: 'hi', cwd: '/w', model: 'opencode/x' },
    ['opencode', 'run', '--auto', '-m', 'opencode/x', '--format', 'json', 'hi'],
  ],
  [
    'gemini',
    { harness: 'gemini', mode: 'conversation', prompt: 'hi', cwd: '/w' },
    ['gemini', '--yolo', '--output-format', 'stream-json', '-p', 'hi'],
  ],
];

describe('a request with no capability set', () => {
  for (const [name, request, argv] of BEFORE)
    it(`builds the argv it built before capability sets: ${name}`, () => {
      assert.deepEqual(turnCommand(request).argv, argv);
    });
});

// ---- the four expedition turn kinds (server: expeditions-v1/executor/access.ts) ----

const caps = (
  files: TurnCapabilities['files'],
  web: TurnCapabilities['web'],
  instructions: TurnCapabilities['instructions']
): TurnCapabilities => ({ files, web, instructions, agents: 'off', schedule: 'off', mcp: 'none' });

const KINDS = {
  // A `tree: none` call: its inputs' and grant's roots, read only; web granted off here.
  seat: {
    cwd: '/x/run/work',
    caps: caps({ t: 'read', roots: ['/x/refs', '/repo/docs'] }, 'off', 'none'),
  },
  // A `tree: checkout` call: its worktree read-write with a shell; web granted on here.
  checkout: {
    cwd: '/x/run/tree',
    caps: caps(
      {
        t: 'write',
        dir: '/x/run/tree',
        reads: ['/x/refs'],
        shell: 'on',
        git: { t: 'worktree', dirs: ['/repo/.git/worktrees/tree', '/repo/.git/objects'] },
      },
      'on',
      'project'
    ),
  },
  judge: { cwd: '/x/run/work', caps: caps({ t: 'read', roots: ['/x/refs'] }, 'off', 'none') },
  // A leader wake: the expedition directory to read, its draft folder (inside it) to write.
  leader: {
    cwd: '/x/drafts/1',
    caps: caps(
      { t: 'write', dir: '/x/drafts/1', reads: ['/x'], shell: 'off', git: { t: 'none' } },
      'off',
      'none'
    ),
  },
} as const;
type Kind = keyof typeof KINDS;

const argvOf = (harness: 'claude' | 'codex', kind: Kind) =>
  turnCommand({
    harness,
    mode: 'conversation',
    prompt: 'p',
    cwd: KINDS[kind].cwd,
    model: 'm',
    yolo: true, // what the server passes for every turn; a capability set ignores it
    capabilities: KINDS[kind].caps,
  }).argv;

const CLAUDE_HEAD = [
  'claude',
  '--model',
  'm',
  '-p',
  '--verbose',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--permission-mode',
  'dontAsk',
  '--permission-prompts',
  'none',
];
const settings = (allow: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    autoMemoryEnabled: false,
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      allow,
    },
    ...extra,
  });
const CLAUDE: Record<Kind, string[]> = {
  seat: [
    ...CLAUDE_HEAD,
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--tools',
    'Read,Grep,Glob',
    '--add-dir',
    '/x/refs',
    '--add-dir',
    '/repo/docs',
    '--settings',
    settings([]),
  ],
  checkout: [
    ...CLAUDE_HEAD,
    '--setting-sources',
    'project',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--tools',
    'Read,Grep,Glob,Edit,Write,NotebookEdit,Bash,WebSearch,WebFetch',
    '--add-dir',
    '/x/refs',
    '--settings',
    settings(['Edit(//x/run/tree/**)', 'Bash', 'WebSearch', 'WebFetch'], {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: ['/x/refs'] },
      },
    }),
  ],
  judge: [
    ...CLAUDE_HEAD,
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--tools',
    'Read,Grep,Glob',
    '--add-dir',
    '/x/refs',
    '--settings',
    settings([]),
  ],
  leader: [
    ...CLAUDE_HEAD,
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--tools',
    'Read,Grep,Glob,Edit,Write,NotebookEdit',
    '--add-dir',
    '/x',
    '--settings',
    settings(['Edit(//x/drafts/1/**)']),
  ],
};

const CODEX_OFF = [
  'multi_agent',
  'multi_agent_v2',
  'apps',
  'plugins',
  'hooks',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'computer_use',
  'in_app_local_automation',
].flatMap((f) => ['--disable', f]);
const codexHead = (cwd: string) => [
  'codex',
  'exec',
  '-C',
  cwd,
  '-m',
  'm',
  '--skip-git-repo-check',
  '--json',
  '--ignore-user-config',
  '--ignore-rules',
  '-c',
  'approval_policy="never"',
];
const WORKSPACE_WRITE = [
  '-s',
  'workspace-write',
  '-c',
  'sandbox_workspace_write.network_access=false',
  '-c',
  'sandbox_workspace_write.exclude_tmpdir_env_var=true',
  '-c',
  'sandbox_workspace_write.exclude_slash_tmp=true',
];
const NO_PROJECT_DOCS = ['-c', 'project_doc_max_bytes=0'];
const CODEX: Record<Kind, string[]> = {
  seat: [
    ...codexHead('/x/run/work'),
    '-s',
    'read-only',
    '-c',
    'web_search="disabled"',
    ...NO_PROJECT_DOCS,
    ...CODEX_OFF,
    '-',
  ],
  // A linked worktree's commit metadata is writable too (types.ts TurnGit): without it the second
  // real run's Codex checkout could not create index.lock and its work stayed uncommitted.
  checkout: [
    ...codexHead('/x/run/tree'),
    ...WORKSPACE_WRITE,
    '-c',
    'sandbox_workspace_write.writable_roots=["/repo/.git/worktrees/tree","/repo/.git/objects"]',
    '-c',
    'web_search="live"',
    ...CODEX_OFF,
    '-',
  ],
  judge: [
    ...codexHead('/x/run/work'),
    '-s',
    'read-only',
    '-c',
    'web_search="disabled"',
    ...NO_PROJECT_DOCS,
    ...CODEX_OFF,
    '-',
  ],
  leader: [
    ...codexHead('/x/drafts/1'),
    ...WORKSPACE_WRITE,
    '-c',
    'web_search="disabled"',
    ...NO_PROJECT_DOCS,
    ...CODEX_OFF,
    '-',
  ],
};

describe('a capability set, per harness and expedition turn kind', () => {
  for (const kind of Object.keys(KINDS) as Kind[]) {
    it(`claude ${kind}: exact argv, no bypass anywhere`, () => {
      const argv = argvOf('claude', kind);
      assert.deepEqual(argv, CLAUDE[kind]);
      assert.ok(!argv.includes('--dangerously-skip-permissions'));
      assert.ok(!argv.includes('bypassPermissions') && !argv.includes('default'));
    });
    it(`codex ${kind}: exact argv, no bypass anywhere`, () => {
      const argv = argvOf('codex', kind);
      assert.deepEqual(argv, CODEX[kind]);
      assert.ok(!argv.includes('--dangerously-bypass-approvals-and-sandbox'));
      assert.ok(!argv.includes('danger-full-access'));
    });
  }
});

const kinds = (report: CapabilityReport) =>
  Object.fromEntries(Object.entries(report).map(([name, e]) => [name, e.t]));

describe('the enforced / advisory report', () => {
  it('claude enforces everything; reads turn advisory only once a shell can read past the roots', () => {
    for (const kind of ['seat', 'judge', 'leader'] as const)
      assert.ok(
        Object.values(capabilityReport('claude', KINDS[kind].caps)).every((e) => e.t === 'enforced'),
        kind
      );
    const checkout = capabilityReport('claude', KINDS.checkout.caps);
    assert.equal(checkout.reads.t, 'advisory');
    assert.match(checkout.reads.t === 'advisory' ? checkout.reads.reason : '', /sandbox/);
    assert.deepEqual(
      Object.entries(checkout).filter(([, e]) => e.t === 'advisory').map(([name]) => name),
      ['reads']
    );
  });

  it('codex says what its sandbox cannot hold, with the reason', () => {
    const seat = capabilityReport('codex', KINDS.seat.caps);
    assert.deepEqual(kinds(seat), {
      reads: 'advisory',
      writes: 'enforced',
      shell: 'advisory',
      web: 'enforced',
      agents: 'advisory',
      schedule: 'enforced',
      mcp: 'enforced',
      instructions: 'advisory',
    });
    assert.match(seat.instructions.t === 'advisory' ? seat.instructions.reason : '', /AGENTS\.md/);
    // Regression (second real run, 2026-11-11): a call with multi_agent{,_v2} disabled still
    // started a sub-agent through collaboration.spawn_agent. The report must say it is not held.
    assert.match(seat.agents.t === 'advisory' ? seat.agents.reason : '', /^NOT held: .*spawn_agent/);
    // A shell granted inside the worktree is what the sandbox does hold.
    assert.equal(capabilityReport('codex', KINDS.checkout.caps).shell.t, 'enforced');
  });

  it('a harness with no mapping runs as before and reports every capability advisory', () => {
    const plain: ExecuteCommandRequest = { harness: 'gemini', mode: 'conversation', prompt: 'hi', cwd: '/w' };
    const limited = turnCommand({ ...plain, capabilities: KINDS.seat.caps });
    assert.deepEqual(limited.argv, turnCommand(plain).argv);
    const report = capabilityReport('gemini', KINDS.seat.caps);
    for (const e of Object.values(report)) {
      assert.equal(e.t, 'advisory');
      assert.match(e.t === 'advisory' ? e.reason : '', /^gemini: .*unrestricted/);
    }
  });
});

describe('a capability set refuses what would widen it', () => {
  const base = {
    harness: 'claude',
    mode: 'conversation',
    prompt: 'p',
    cwd: '/x/run/work',
    capabilities: KINDS.seat.caps,
  } as const;
  it('an MCP server, extra args, or a codex fullAuto / webSearch', () => {
    assert.throws(() => turnCommand({ ...base, mcpServers: { s: HTTP } }), /takes no mcpServers/);
    // A second `--settings` would replace the set's (Claude does not merge them).
    assert.throws(
      () => turnCommand({ ...base, extraArgs: ['--settings', '{}'] }),
      /takes no extraArgs/
    );
    assert.throws(
      () => turnCommand({ ...base, harness: 'codex', fullAuto: true, webSearch: true }),
      /takes no fullAuto, webSearch/
    );
  });
  it('a writable directory that is not the turn cwd', () => {
    assert.throws(
      () => turnCommand({ ...base, cwd: '/elsewhere', capabilities: KINDS.leader.caps }),
      /must be the turn's cwd/
    );
  });
});
