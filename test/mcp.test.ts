import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  type BuildOptions,
  buildCommand,
  harnessMcpCapability,
  harnessSupportsMcp,
} from '../src/index.ts';
import { createMuseParser } from '../src/parsers/muse.ts';

const buddyServer = {
  unleashd_buddy: {
    kind: 'stdio',
    command: '/usr/bin/node',
    args: [
      '--import',
      'tsx',
      '/srv/unleashd/server/src/buddies/mcp-server.ts',
      '--buddy',
      'buddy_123',
    ],
    cwd: '/srv/unleashd/server',
    env: { UNLEASHD_BUDDY_CONTROL_TOKEN: 'not-in-agent-argv' },
    required: true,
  },
} as const;

const optionalBuddyServer = {
  unleashd_buddy: { ...buddyServer.unleashd_buddy, required: false },
} as const;

const optionalBuddyServerWithoutEnv = {
  unleashd_buddy: {
    ...buddyServer.unleashd_buddy,
    required: false,
    env: undefined,
  },
} as const;

// Muse settings dirs are owned by the run (runCommand deletes them); these
// tests only build, so they delete what they created.
const createdMusePaths: string[] = [];
function buildMuse(options: BuildOptions) {
  const spec = buildCommand('muse', options);
  createdMusePaths.push(...spec.ownedPaths);
  return spec;
}

describe('MCP encoding', () => {
  after(() => {
    for (const path of createdMusePaths) rmSync(path, { recursive: true, force: true });
  });

  it('pins the additive Codex TOML argv byte-for-byte', () => {
    const spec = buildCommand('codex', {
      prompt: 'work',
      mcpServers: buddyServer,
    });

    assert.deepStrictEqual(spec.argv, [
      'codex',
      'exec',
      '--skip-git-repo-check',
      '-c',
      'mcp_servers.unleashd_buddy.command="/usr/bin/node"',
      '-c',
      'mcp_servers.unleashd_buddy.args=["--import","tsx","/srv/unleashd/server/src/buddies/mcp-server.ts","--buddy","buddy_123"]',
      '-c',
      'mcp_servers.unleashd_buddy.enabled=true',
      '-c',
      'mcp_servers.unleashd_buddy.required=true',
      '-c',
      'mcp_servers.unleashd_buddy.cwd="/srv/unleashd/server"',
      '-c',
      'mcp_servers.unleashd_buddy.env_vars=["UNLEASHD_BUDDY_CONTROL_TOKEN"]',
      '-',
    ]);
    assert.strictEqual(spec.prompt, 'work');
    assert.strictEqual(spec.stdin, 'prompt');
    assert.deepStrictEqual(spec.env, {
      UNLEASHD_BUDDY_CONTROL_TOKEN: 'not-in-agent-argv',
    });
    assert.ok(!spec.argv.some((argument) => argument.includes('not-in-agent-argv')));
  });

  it('encodes Claude inline with an isolated MCP configuration', () => {
    const spec = buildCommand('claude', {
      prompt: 'work',
      mcpServers: buddyServer,
    });

    assert.ok(spec.argv.includes('--strict-mcp-config'));
    const flagIndex = spec.argv.indexOf('--mcp-config');
    assert.notStrictEqual(flagIndex, -1);
    assert.deepStrictEqual(JSON.parse(spec.argv[flagIndex + 1]!), {
      mcpServers: {
        unleashd_buddy: {
          command: '/usr/bin/node',
          args: [
            '--import',
            'tsx',
            '/srv/unleashd/server/src/buddies/mcp-server.ts',
            '--buddy',
            'buddy_123',
          ],
          cwd: '/srv/unleashd/server',
        },
      },
    });
    assert.deepStrictEqual(spec.env, {
      UNLEASHD_BUDDY_CONTROL_TOKEN: 'not-in-agent-argv',
    });
    assert.ok(!spec.argv.some((argument) => argument.includes('not-in-agent-argv')));
  });

  it('encodes OpenCode in the spawn environment and leaves the prompt last', () => {
    const spec = buildCommand('opencode', {
      prompt: 'work',
      mcpServers: optionalBuddyServer,
    });

    assert.strictEqual(spec.argv.at(-1), 'work');
    assert.deepStrictEqual(JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? ''), {
      mcp: {
        unleashd_buddy: {
          type: 'local',
          command: [
            '/usr/bin/node',
            '--import',
            'tsx',
            '/srv/unleashd/server/src/buddies/mcp-server.ts',
            '--buddy',
            'buddy_123',
          ],
          enabled: true,
          cwd: '/srv/unleashd/server',
          environment: { UNLEASHD_BUDDY_CONTROL_TOKEN: 'not-in-agent-argv' },
        },
      },
    });
  });

  it('advertises MCP support explicitly for every harness', () => {
    assert.strictEqual(harnessSupportsMcp('codex'), true);
    assert.strictEqual(harnessSupportsMcp('claude'), true);
    assert.strictEqual(harnessSupportsMcp('opencode'), true);
    assert.strictEqual(harnessSupportsMcp('muse'), true);
    assert.strictEqual(harnessSupportsMcp('gemini'), false);
    assert.strictEqual(harnessSupportsMcp('gemini2'), false);
    assert.strictEqual(harnessSupportsMcp('cursor'), true);
  });

  it('distinguishes injection from fail-closed required MCP', () => {
    assert.strictEqual(harnessMcpCapability('codex'), 'required');
    assert.strictEqual(harnessMcpCapability('claude'), 'required');
    assert.strictEqual(harnessMcpCapability('muse'), 'required');
    assert.strictEqual(harnessMcpCapability('opencode'), 'inject');
  });

  it('rejects required MCP when a harness can only inject it', () => {
    assert.throws(
      () => buildCommand('opencode', { prompt: 'work', mcpServers: buddyServer }),
      /cannot guarantee required MCP server.*unleashd_buddy/
    );
  });

  it('encodes muse required MCP through a merged XDG settings file', () => {
    const fixtureBase = mkdtempSync(join(tmpdir(), 'muse-mcp-test-'));
    mkdirSync(join(fixtureBase, 'muse'), { recursive: true });
    writeFileSync(
      join(fixtureBase, 'muse', 'settings.json'),
      JSON.stringify({
        schema_version: 1,
        model: 'user-default-model',
        mcp_servers: {
          user_tool: { type: 'stdio', command: 'user-bin', args: [] },
        },
      })
    );
    const savedXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = fixtureBase;
      const spec = buildMuse({
        prompt: 'work',
        mcpServers: buddyServer,
      });

      // No MCP on argv: the prompt stays last and secrets never touch argv.
      assert.deepStrictEqual(spec.argv, ['muse', 'exec', 'work']);
      assert.ok(!spec.argv.some((argument) => argument.includes('not-in-agent-argv')));
      const xdgBase = spec.env?.XDG_CONFIG_HOME;
      assert.ok(typeof xdgBase === 'string' && xdgBase.length > 0);

      const merged = JSON.parse(
        readFileSync(join(xdgBase, 'muse', 'settings.json'), 'utf-8')
      ) as {
        schema_version: number;
        model: string;
        mcpServers: Record<string, Record<string, unknown>>;
      };
      assert.strictEqual(merged.schema_version, 1);
      // Regression B5: muse 1.4.0 drops the WHOLE MCP member when the legacy
      // `mcp_servers` key sits next to `mcpServers`, so a legacy user block
      // must be folded into `mcpServers`, never written back.
      assert.ok(!('mcp_servers' in merged));
      // User settings survive the merge untouched.
      assert.strictEqual(merged.model, 'user-default-model');
      assert.deepStrictEqual(merged.mcpServers['user_tool'], {
        type: 'stdio',
        command: 'user-bin',
        args: [],
      });
      // Required servers land with explicit fail-closed mode.
      assert.deepStrictEqual(merged.mcpServers['unleashd_buddy'], {
        type: 'stdio',
        command: '/usr/bin/node',
        args: [
          '--import',
          'tsx',
          '/srv/unleashd/server/src/buddies/mcp-server.ts',
          '--buddy',
          'buddy_123',
        ],
        env: { UNLEASHD_BUDDY_CONTROL_TOKEN: 'not-in-agent-argv' },
        enabled: true,
        mode: 'required',
      });
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  it('marks explicitly optional muse servers optional instead of failing', () => {
    const fixtureBase = mkdtempSync(join(tmpdir(), 'muse-mcp-test-'));
    const savedXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = fixtureBase;
      const spec = buildMuse({
        prompt: 'work',
        mcpServers: optionalBuddyServer,
      });
      const merged = JSON.parse(
        readFileSync(join(spec.env?.XDG_CONFIG_HOME ?? '', 'muse', 'settings.json'), 'utf-8')
      ) as { mcpServers: Record<string, Record<string, unknown>> };
      assert.strictEqual(merged.mcpServers['unleashd_buddy']?.['mode'], 'optional');
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  it('forwards parent BUDDIES_HOME so the child opens the same store', () => {
    const fixtureBase = mkdtempSync(join(tmpdir(), 'muse-mcp-test-'));
    const savedXdg = process.env.XDG_CONFIG_HOME;
    const savedBuddiesHome = process.env.BUDDIES_HOME;
    try {
      process.env.XDG_CONFIG_HOME = fixtureBase;
      process.env.BUDDIES_HOME = '/tmp/parent-scoped-store';
      const spec = buildMuse({
        prompt: 'work',
        mcpServers: optionalBuddyServerWithoutEnv,
      });
      const merged = JSON.parse(
        readFileSync(join(spec.env?.XDG_CONFIG_HOME ?? '', 'muse', 'settings.json'), 'utf-8')
      ) as { mcpServers: Record<string, Record<string, unknown>> };
      assert.deepStrictEqual(merged.mcpServers['unleashd_buddy']?.['env'], {
        BUDDIES_HOME: '/tmp/parent-scoped-store',
      });
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      if (savedBuddiesHome === undefined) delete process.env.BUDDIES_HOME;
      else process.env.BUDDIES_HOME = savedBuddiesHome;
    }
  });

  it('refuses to shadow a conflicting user muse server', () => {
    const fixtureBase = mkdtempSync(join(tmpdir(), 'muse-mcp-test-'));
    mkdirSync(join(fixtureBase, 'muse'), { recursive: true });
    writeFileSync(
      join(fixtureBase, 'muse', 'settings.json'),
      JSON.stringify({
        schema_version: 1,
        mcpServers: { unleashd_buddy: { type: 'stdio', command: 'user-bin', args: [] } },
      })
    );
    const savedXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = fixtureBase;
      assert.throws(
        () => buildCommand('muse', { prompt: 'work', mcpServers: buddyServer }),
        /refuses to shadow/
      );
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  it('surfaces muse tool.result completions as tool.use', () => {
    assert.deepStrictEqual(
      createMuseParser()({
        payload_type: 'tool.result',
        payload: {
          call_id: 'call_1',
          text: 'pong:hello',
          correlation_facts: { tool_name: 'mcp__unleashd_buddy__remember', outcome: 'success' },
        },
      }),
      [
        { type: 'tool.use', name: 'mcp__unleashd_buddy__remember', input: {} },
        { type: 'tool.result', output: 'pong:hello', isError: false },
      ]
    );
    assert.deepStrictEqual(createMuseParser()({ payload_type: 'tool.result', payload: {} }), [
      { type: 'tool.use', name: 'mcp_tool', input: {} },
    ]);
  });
});
