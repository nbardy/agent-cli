import type { McpHttpServer, McpServerSpec, McpStdioServer } from './types.ts';

/**
 * Shared shape for per-harness MCP encoders.
 *
 * Every harness writes ONE handler per transport kind (`stdio`, `http`) that
 * turns a canonical server into that CLI's entry plus any process env it
 * needs. `encodeMcpServers` is the thin dispatcher over `McpServerSpec.kind`
 * and the one place env contributions are merged (a conflicting value for the
 * same variable is an error, never a silent overwrite).
 */
export interface EncodedMcpEntry<Entry> {
  readonly entry: Entry;
  readonly env: Readonly<Record<string, string>>;
}

export interface McpKindEncoders<Entry> {
  readonly stdio: (name: string, spec: McpStdioServer) => EncodedMcpEntry<Entry>;
  readonly http: (name: string, spec: McpHttpServer) => EncodedMcpEntry<Entry>;
}

export interface EncodedMcpServers<Entry> {
  readonly entries: ReadonlyArray<readonly [string, Entry]>;
  readonly env: Readonly<Record<string, string>>;
}

function encodeMcpEntry<Entry>(
  encoders: McpKindEncoders<Entry>,
  name: string,
  spec: McpServerSpec
): EncodedMcpEntry<Entry> {
  switch (spec.kind) {
    case 'stdio':
      return encoders.stdio(name, spec);
    case 'http':
      return encoders.http(name, spec);
  }
}

export function encodeMcpServers<Entry>(
  encoders: McpKindEncoders<Entry>,
  servers: Readonly<Record<string, McpServerSpec>>
): EncodedMcpServers<Entry> {
  const entries: Array<readonly [string, Entry]> = [];
  const env: Record<string, string> = {};
  for (const [name, spec] of Object.entries(servers)) {
    const encoded = encodeMcpEntry(encoders, name, spec);
    for (const [key, value] of Object.entries(encoded.env)) {
      if (key in env && env[key] !== value) {
        throw new Error(`MCP servers require conflicting values for environment variable ${key}`);
      }
      env[key] = value;
    }
    entries.push([name, encoded.entry]);
  }
  return { entries, env };
}

function envToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Name of the env var that carries one HTTP header value, for CLIs that can
 * read header values from their own environment. Deterministic so encoder
 * tests can pin the exact config; two servers whose names sanitize to the
 * same token with different values hit the conflict check above.
 */
export function mcpHeaderEnvName(server: string, header: string): string {
  return `AGENT_CLI_MCP_${envToken(server)}__${envToken(header)}`;
}

/**
 * Move every header value into the process env and reference it from the
 * config by `reference(envName)` (claude `${VAR}`, codex bare name, cursor
 * `${env:VAR}`). The returned headers map holds references only, so the
 * bearer token never appears in argv or on disk.
 */
export function headersViaEnv(
  server: string,
  headers: Readonly<Record<string, string>>,
  reference: (envName: string) => string
): { readonly headers: Record<string, string>; readonly env: Record<string, string> } {
  const refs: Record<string, string> = {};
  const env: Record<string, string> = {};
  for (const [header, value] of Object.entries(headers)) {
    const envName = mcpHeaderEnvName(server, header);
    refs[header] = reference(envName);
    env[envName] = value;
  }
  return { headers: refs, env };
}
