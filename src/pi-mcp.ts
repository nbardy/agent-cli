import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpEncoding, McpServerSpec } from './types.ts';

// Pattern: capability-grants (docs/patterns.md#capability-grants)
// Native Pi connects MCP in the background and otherwise continues without it.
// The required-MCP guard waits for the actual native tools before any model
// request. A concurrent external probe cannot earn this guarantee (Pi startup guard).
export function buildPiMcpExtension(
  servers: Readonly<Record<string, McpServerSpec>>
): McpEncoding {
  const env: Record<string, string> = {};
  const entries = Object.entries(servers).map(([name, spec], index) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid Pi MCP name: ${name}`);
    const config: Record<string, unknown> = { exposure: 'codemode', timeout: 15 };
    if (spec.kind === 'http') {
      config.url = spec.url;
      config.headers = Object.fromEntries(Object.entries(spec.headers ?? {}).map(([key, value], h) => {
        const variable = `AGENT_CLI_PI_MCP_${index}_${h}`;
        env[variable] = value;
        return [key, '${' + variable + '}'];
      }));
    } else {
      Object.assign(config, { command: spec.command, args: spec.args, cwd: spec.cwd });
      config.env = Object.fromEntries(Object.entries(spec.env ?? {}).map(([key, value], e) => {
        const variable = `AGENT_CLI_PI_MCP_${index}_${e}`;
        env[variable] = value;
        return [key, '${' + variable + '}'];
      }));
    }
    return { name, config, required: spec.required === true };
  });
  const dir = mkdtempSync(join(tmpdir(), 'agent-cli-pi-mcp-'));
  const file = join(dir, 'mcp.mjs');
  writeFileSync(file, `
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
const entries = ${JSON.stringify(entries)};
const fail = (message) => {
  process.stderr.write('ERROR: Pi required MCP startup: ' + message + '\\n');
  process.exit(1);
};
export default function(pi) {
  // A configured server overrides an extension registration. Never let an
  // owner's same-name config replace this turn's authority-bearing endpoint.
  pi.on('session_start', async (_event, ctx) => {
    for (const file of [join(getAgentDir(), 'mcp.json'), join(ctx.cwd, '.pi', 'mcp.json')]) {
      if (!existsSync(file)) continue;
      const configured = JSON.parse(readFileSync(file, 'utf8')).mcpServers || {};
      for (const entry of entries) {
        if (Object.keys(configured).some(name => name.replaceAll('-', '_') === entry.name.replaceAll('-', '_'))) {
          fail('server name conflicts with existing configuration: ' + entry.name);
        }
      }
    }
  });
  for (const entry of entries) pi.registerMcpServer(entry.name, entry.config);
  pi.on('before_agent_start', async () => {
    const required = entries.filter(entry => entry.required);
    if (!required.length) return;
    const deadline = Date.now() + 15000;
    while (true) {
      const tools = pi.getAllTools();
      const missing = required.filter(entry => !tools.some(tool => tool.name.startsWith('mcp__' + entry.name.replaceAll('-', '_') + '__')));
      if (!missing.length) {
        if (!pi.getActiveTools().includes('codemode')) fail('codemode is disabled');
        return;
      }
      if (Date.now() >= deadline) fail('tools unavailable for ' + missing.map(entry => entry.name).join(', '));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  });
}
`, { mode: 0o600 });
  return { args: ['--extension', file], env, ownedPaths: [dir] };
}
