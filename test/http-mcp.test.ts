import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  type McpServerSpec,
  type UnifiedAgentEvent,
  buildCommand,
  executeCommand,
  probeMcpServerStartup,
  runCommand,
} from '../src/index.ts';

// The per-CLI config shapes below ARE the contract with each CLI: every one
// was checked against the installed binary on 2026-09-25 (see the comments at
// each encoder). A change here must be re-verified against the CLI, not just
// re-pinned.

const TOKEN = 'turn-token-secret';
const AUTH_ENV = 'AGENT_CLI_MCP_UNLEASHD_BUDDY__AUTHORIZATION';

const httpServer = (url: string, required = true): Record<string, McpServerSpec> => ({
  unleashd_buddy: {
    kind: 'http',
    url,
    headers: { Authorization: `Bearer ${TOKEN}` },
    required,
  },
});

function withXdg<T>(run: (base: string) => T): T {
  const base = mkdtempSync(join(tmpdir(), 'http-mcp-xdg-'));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = base;
  try {
    return run(base);
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
}

describe('HTTP MCP encoders', () => {
  const url = 'http://127.0.0.1:4999/mcp';

  it('claude: http entry with a ${VAR} header reference; token only in env', () => {
    const spec = buildCommand('claude', { prompt: 'work', mcpServers: httpServer(url) });
    const config = JSON.parse(spec.argv[spec.argv.indexOf('--mcp-config') + 1]!);
    assert.deepStrictEqual(config, {
      mcpServers: {
        unleashd_buddy: {
          type: 'http',
          url,
          headers: { Authorization: `\${${AUTH_ENV}}` },
        },
      },
    });
    assert.ok(spec.argv.includes('--strict-mcp-config'));
    assert.deepStrictEqual(spec.env, { [AUTH_ENV]: `Bearer ${TOKEN}` });
    assert.ok(!spec.argv.some((argument) => argument.includes(TOKEN)));
  });

  it('claude: stdio and http servers share one isolated config', () => {
    const spec = buildCommand('claude', {
      prompt: 'work',
      mcpServers: {
        ...httpServer(url),
        helper: { kind: 'stdio', command: '/bin/helper', args: ['--x'], env: { H: '1' } },
      },
    });
    const config = JSON.parse(spec.argv[spec.argv.indexOf('--mcp-config') + 1]!);
    assert.deepStrictEqual(Object.keys(config.mcpServers), ['unleashd_buddy', 'helper']);
    assert.deepStrictEqual(config.mcpServers.helper, { command: '/bin/helper', args: ['--x'] });
    assert.deepStrictEqual(spec.env, { [AUTH_ENV]: `Bearer ${TOKEN}`, H: '1' });
  });

  it('codex: url + env_http_headers (inline bearer_token is rejected by codex)', () => {
    const spec = buildCommand('codex', { prompt: 'work', mcpServers: httpServer(url) });
    assert.deepStrictEqual(spec.argv, [
      'codex',
      'exec',
      '--skip-git-repo-check',
      '-c',
      `mcp_servers.unleashd_buddy.url="${url}"`,
      '-c',
      'mcp_servers.unleashd_buddy.enabled=true',
      '-c',
      'mcp_servers.unleashd_buddy.required=true',
      '-c',
      `mcp_servers.unleashd_buddy.env_http_headers={"Authorization"="${AUTH_ENV}"}`,
      '-',
    ]);
    assert.deepStrictEqual(spec.env, { [AUTH_ENV]: `Bearer ${TOKEN}` });
  });

  it('cursor: plugin .mcp.json {url, headers} with ${env:VAR}; the file holds no token', () => {
    const spec = buildCommand('cursor', { prompt: 'work', mcpServers: httpServer(url) });
    const pluginDir = spec.argv[spec.argv.indexOf('--plugin-dir') + 1]!;
    const content = readFileSync(join(pluginDir, '.mcp.json'), 'utf-8');
    assert.deepStrictEqual(JSON.parse(content), {
      mcpServers: {
        unleashd_buddy: { url, headers: { Authorization: `\${env:${AUTH_ENV}}` } },
      },
    });
    assert.ok(!content.includes(TOKEN));
    assert.ok(spec.argv.includes('--approve-mcps'));
    assert.deepStrictEqual(spec.env, { [AUTH_ENV]: `Bearer ${TOKEN}` });
  });

  it('muse: streamable-http under mcpServers with a literal header in a 0600 owned file', () => {
    withXdg(() => {
      const spec = buildCommand('muse', { prompt: 'work', mcpServers: httpServer(url) });
      const baseDir = spec.env?.XDG_CONFIG_HOME ?? '';
      const settingsPath = join(baseDir, 'muse', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      assert.deepStrictEqual(settings, {
        schema_version: 1,
        mcpServers: {
          unleashd_buddy: {
            type: 'streamable-http',
            url,
            headers: { Authorization: `Bearer ${TOKEN}` },
            enabled: true,
            mode: 'required',
          },
        },
      });
      assert.strictEqual(statSync(settingsPath).mode & 0o777, 0o600);
      assert.strictEqual(statSync(baseDir).mode & 0o777, 0o700);
      // The token is on disk, so the dir must be owned by the run and deleted
      // with it (see the runCommand cleanup test below).
      assert.deepStrictEqual(spec.ownedPaths, [baseDir]);
      assert.ok(!spec.argv.some((argument) => argument.includes(TOKEN)));
      rmSync(baseDir, { recursive: true, force: true });
    });
  });

  it('opencode: remote entry with literal headers inside OPENCODE_CONFIG_CONTENT', () => {
    const spec = buildCommand('opencode', { prompt: 'work', mcpServers: httpServer(url, false) });
    assert.deepStrictEqual(JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? ''), {
      mcp: {
        unleashd_buddy: {
          type: 'remote',
          url,
          enabled: true,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    });
    assert.ok(!spec.argv.some((argument) => argument.includes(TOKEN)));
  });
});

// A real stateless streamable-HTTP MCP server (the shape the unleashd server
// will serve Buddy tools with), requiring a bearer token.
function startMcpServer(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const mcp = new McpServer({ name: 'probe-fixture', version: '1' });
    mcp.registerTool('ping', { description: 'pong' }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

async function collectEvents(events: AsyncIterable<UnifiedAgentEvent>): Promise<UnifiedAgentEvent[]> {
  const out: UnifiedAgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('HTTP MCP startup probe against a live streamable-HTTP server', () => {
  let server: Server;
  let url = '';
  let binDir = '';
  const originalPath = process.env.PATH ?? '';

  before(async () => {
    ({ server, url } = await startMcpServer());
    binDir = mkdtempSync(join(tmpdir(), 'http-mcp-bin-'));
    // Claude-shaped shim: succeeds without ever touching MCP, like claude does
    // when an HTTP server fails (it reports status "failed" and runs on).
    writeFileSync(
      join(binDir, 'claude'),
      `#!/usr/bin/env node
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
setTimeout(() => {
  emit({ type: 'system', subtype: 'init', session_id: 'http-mcp-session' });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  emit({ type: 'result', subtype: 'success' });
}, 300);
`
    );
    chmodSync(join(binDir, 'claude'), 0o755);
    // Muse shim: records whether its settings dir existed while it ran.
    writeFileSync(
      join(binDir, 'muse'),
      `#!/bin/sh
test -f "$XDG_CONFIG_HOME/muse/settings.json" && echo present > "${binDir}/muse-saw-settings"
`
    );
    chmodSync(join(binDir, 'muse'), 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;
  });

  after(() => {
    process.env.PATH = originalPath;
    server.close();
    rmSync(binDir, { recursive: true, force: true });
  });

  it('completes initialize + tools/list with the right bearer', async () => {
    await probeMcpServerStartup('unleashd_buddy', httpServer(url).unleashd_buddy!);
  });

  it('rejects a wrong bearer loudly', async () => {
    await assert.rejects(
      probeMcpServerStartup('unleashd_buddy', {
        kind: 'http',
        url,
        headers: { Authorization: 'Bearer wrong' },
      }),
      /MCP server `unleashd_buddy` failed during startup: initialize returned HTTP 401/
    );
  });

  it('rejects an unreachable URL loudly', async () => {
    const dead = await startMcpServer();
    dead.server.close();
    await new Promise((resolve) => dead.server.on('close', resolve));
    await assert.rejects(
      probeMcpServerStartup('unleashd_buddy', httpServer(dead.url).unleashd_buddy!),
      /MCP server `unleashd_buddy` failed during startup: fetch failed/
    );
  });

  // Claude drops a failed HTTP server silently, so without the runner's probe
  // this turn would report success with no Buddy tools.
  it('fails a claude turn whose required HTTP server rejects the token', async () => {
    const turn = executeCommand({
      harness: 'claude',
      mode: 'conversation',
      prompt: 'work',
      cwd: binDir,
      yolo: true,
      mcpServers: {
        unleashd_buddy: { kind: 'http', url, headers: { Authorization: 'Bearer revoked' }, required: true },
      },
    });
    const eventsPromise = collectEvents(turn.events);
    const completion = await turn.completed;
    const events = await eventsPromise;
    assert.strictEqual(completion.reason, 'error');
    assert.ok(
      events.some(
        (event) => event.type === 'error' && /`unleashd_buddy` failed during startup: initialize returned HTTP 401/.test(event.message)
      )
    );
  });

  it('admits a claude turn whose required HTTP server lists its tools', async () => {
    const turn = executeCommand({
      harness: 'claude',
      mode: 'conversation',
      prompt: 'work',
      cwd: binDir,
      yolo: true,
      mcpServers: httpServer(url),
    });
    const eventsPromise = collectEvents(turn.events);
    const completion = await turn.completed;
    await eventsPromise;
    assert.strictEqual(completion.reason, 'success');
  });

  it('deletes the muse settings dir holding the literal token when the process exits', async () => {
    await withXdg(async () => {
      const { spec, done } = runCommand('muse', { prompt: 'work', mcpServers: httpServer(url) });
      const baseDir = spec.env?.XDG_CONFIG_HOME ?? '';
      await done;
      assert.strictEqual(readFileSync(join(binDir, 'muse-saw-settings'), 'utf-8').trim(), 'present');
      assert.ok(!existsSync(baseDir), `token-bearing dir survived the run: ${baseDir}`);
    });
  });
});
