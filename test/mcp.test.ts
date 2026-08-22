import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCommand, harnessSupportsMcp } from '../src/index.ts';

const buddyServer = {
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
    required: true,
  },
} as const;

describe('MCP encoding', () => {
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
      '--',
      'work',
    ]);
    assert.strictEqual(spec.env, undefined);
  });

  it('encodes Claude inline without evicting globally configured servers', () => {
    const spec = buildCommand('claude', {
      prompt: 'work',
      mcpServers: buddyServer,
    });

    assert.ok(!spec.argv.includes('--strict-mcp-config'));
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
  });

  it('encodes OpenCode in the spawn environment and leaves the prompt last', () => {
    const spec = buildCommand('opencode', {
      prompt: 'work',
      mcpServers: buddyServer,
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
        },
      },
    });
  });

  it('advertises MCP support explicitly for every harness', () => {
    assert.strictEqual(harnessSupportsMcp('codex'), true);
    assert.strictEqual(harnessSupportsMcp('claude'), true);
    assert.strictEqual(harnessSupportsMcp('opencode'), true);
    assert.strictEqual(harnessSupportsMcp('muse'), false);
    assert.strictEqual(harnessSupportsMcp('gemini'), false);
    assert.strictEqual(harnessSupportsMcp('gemini2'), false);
    assert.strictEqual(harnessSupportsMcp('cursor'), false);
  });

  it('fails closed rather than inventing MCP syntax for Muse', () => {
    assert.throws(
      () =>
        buildCommand('muse', {
          prompt: 'work',
          mcpServers: buddyServer,
        }),
      /cannot encode required MCP server.*unleashd_buddy/
    );
  });

  it('may ignore explicitly optional MCP on an unsupported harness', () => {
    const spec = buildCommand('muse', {
      prompt: 'work',
      mcpServers: {
        optional_probe: {
          command: '/usr/bin/false',
          args: [],
        },
      },
    });
    assert.deepStrictEqual(spec.argv, ['muse', 'exec', 'work']);
    assert.strictEqual(spec.env, undefined);
  });
});
