import { spawn } from 'node:child_process';
import { forwardedMcpEnv } from './mcp-env.ts';
import type { HarnessConfig, McpHttpServer, McpServerSpec, McpStdioServer } from './types.ts';

const PROBE_TIMEOUT_MS = 30_000;

/**
 * Required-server startup probes, one per transport kind. Every probe
 * completes `initialize` + `tools/list` and rejects with
 * `MCP server \`name\` failed during startup: ...`, the same wording muse
 * uses for its native fail-closed abort.
 *
 * They prove the SERVER answers, not that the CLI connected it — a CLI-side
 * loading regression still needs an opt-in live test.
 */
export function probeMcpServerStartup(name: string, spec: McpServerSpec): Promise<void> {
  switch (spec.kind) {
    case 'stdio':
      return probeStdioMcpServer(name, spec);
    case 'http':
      return probeHttpMcpServer(name, spec);
  }
}

/**
 * Whether the runner must probe this required server for this harness.
 *
 * stdio: only where the CLI drops a failed server silently (cursor,
 * `probeRequiredMcpStartup`); elsewhere a probe would spawn the server twice.
 * http: always. A probe is one round trip, and claude also drops a failed
 * HTTP server silently (init event `status:"failed"`, verified 2026-09-25),
 * so a dead URL or rejected token must fail the turn on every harness.
 */
export function requiresStartupProbe(config: HarnessConfig, spec: McpServerSpec): boolean {
  switch (spec.kind) {
    case 'stdio':
      return config.probeRequiredMcpStartup === true;
    case 'http':
      return true;
  }
}

function startupError(name: string, detail: string): Error {
  return new Error(`MCP server \`${name}\` failed during startup: ${detail}`);
}

interface JsonRpcReply {
  readonly id?: unknown;
  readonly result?: { readonly tools?: unknown; readonly protocolVersion?: unknown };
  readonly error?: { readonly message?: unknown };
}

/** Pull the JSON-RPC reply with `id` out of a JSON or SSE response body. */
function replyFromBody(contentType: string, body: string, id: number): JsonRpcReply | undefined {
  const messages: unknown[] = contentType.includes('text/event-stream')
    ? body
        .split(/\r?\n\r?\n/)
        .map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
        )
        .filter((data) => data.length > 0)
        .map((data) => JSON.parse(data) as unknown)
    : [JSON.parse(body) as unknown].flat();
  return messages.find(
    (message): message is JsonRpcReply =>
      typeof message === 'object' && message !== null && (message as JsonRpcReply).id === id
  );
}

/**
 * Prove a required streamable-HTTP MCP server answers with the turn's
 * credentials: POST `initialize`, `notifications/initialized`, then
 * `tools/list` to the exact URL with the exact headers the CLI will send.
 * Works against stateless servers and carries `Mcp-Session-Id` for stateful
 * ones (deleting that session afterwards).
 */
export async function probeHttpMcpServer(name: string, spec: McpHttpServer): Promise<void> {
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const headers: Record<string, string> = {
    ...spec.headers,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const post = async (message: Record<string, unknown>): Promise<Response> => {
    try {
      return await fetch(spec.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
        signal,
      });
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      throw startupError(
        name,
        `${signal.aborted ? `no reply within ${PROBE_TIMEOUT_MS}ms` : error instanceof Error ? error.message : String(error)}${cause}`
      );
    }
  };
  const request = async (id: number, method: string, params: unknown): Promise<JsonRpcReply> => {
    const response = await post({ id, method, params });
    const body = await response.text();
    if (!response.ok) {
      throw startupError(name, `${method} returned HTTP ${response.status}${body ? ` (${body.slice(0, 200)})` : ''}`);
    }
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    let reply: JsonRpcReply | undefined;
    try {
      reply = replyFromBody(response.headers.get('content-type') ?? '', body, id);
    } catch (error) {
      throw startupError(name, `${method} reply is not JSON-RPC: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!reply) throw startupError(name, `${method} returned no reply for request ${id}`);
    if (reply.error) throw startupError(name, `JSON-RPC error: ${String(reply.error.message)}`);
    return reply;
  };

  const initialized = await request(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'agent-cli-startup-probe', version: '1' },
  });
  if (typeof initialized.result?.protocolVersion === 'string') {
    headers['MCP-Protocol-Version'] = initialized.result.protocolVersion;
  }
  const notified = await post({ method: 'notifications/initialized' });
  await notified.text();
  if (!notified.ok) {
    throw startupError(name, `notifications/initialized returned HTTP ${notified.status}`);
  }
  const listed = await request(2, 'tools/list', {});
  if (!Array.isArray(listed.result?.tools)) throw startupError(name, 'tools/list returned no tools array');
  if (headers['Mcp-Session-Id']) {
    await fetch(spec.url, { method: 'DELETE', headers, signal }).then(
      (response) => response.text(),
      () => undefined
    );
  }
}

/**
 * Prove a required stdio MCP server can start: spawn it exactly as the CLI
 * will (command, args, cwd, scrubbed env + declared env), complete the
 * `initialize` handshake and read a `tools/list` result, then stop it.
 */
function probeStdioMcpServer(name: string, spec: McpStdioServer): Promise<void> {
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
