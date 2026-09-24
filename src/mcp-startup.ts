import { spawn } from 'node:child_process';
import { forwardedMcpEnv } from './mcp-env.ts';
import type { McpServerSpec } from './types.ts';

const PROBE_TIMEOUT_MS = 30_000;

/**
 * Prove a required stdio MCP server can start: spawn it exactly as the CLI
 * will (command, args, cwd, scrubbed env + declared env), complete the
 * `initialize` handshake and read a `tools/list` result, then stop it.
 *
 * Only for harnesses whose CLI drops a failed server silently (cursor). It
 * proves the SERVER starts, not that the CLI connected it — a CLI-side loading
 * regression still needs the opt-in live test (test/live-cursor-mcp.test.ts).
 * Rejects with `MCP server \`name\` failed during startup: ...`, the same
 * wording muse uses for its native fail-closed abort.
 */
export function probeMcpServerStartup(name: string, spec: McpServerSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: {
        HOME: process.env.HOME ?? '',
        PATH: process.env.PATH ?? '',
        ...forwardedMcpEnv(),
        ...spec.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ');
        reject(
          new Error(`MCP server \`${name}\` failed during startup: ${error}${tail ? ` (${tail})` : ''}`)
        );
      } else resolve();
    };
    const timer = setTimeout(() => finish(`no tools/list reply within ${PROBE_TIMEOUT_MS}ms`), PROBE_TIMEOUT_MS);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

    child.on('error', (error) => finish(error.message));
    child.on('exit', (code, signal) => finish(`exited (${signal ?? code}) before listing tools`));
    child.stdin.on('error', () => {
      // EPIPE from a server that already died; the exit handler reports it.
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let index = stdout.indexOf('\n');
      while (index >= 0) {
        const line = stdout.slice(0, index).trim();
        stdout = stdout.slice(index + 1);
        index = stdout.indexOf('\n');
        let message: { id?: unknown; result?: { tools?: unknown }; error?: { message?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.error) return finish(`JSON-RPC error: ${String(message.error.message)}`);
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          return Array.isArray(message.result?.tools)
            ? finish()
            : finish('tools/list returned no tools array');
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'agent-cli-startup-probe', version: '1' },
      },
    });
  });
}
