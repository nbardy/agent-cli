import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCommand } from '../src/build.ts';
import { attachExecution, executeCommand } from '../src/execute.ts';
import { createPiParser } from '../src/parsers/pi.ts';
import type { UnifiedAgentEvent } from '../src/runtime-types.ts';

test('Pi settlement includes compaction continuation and preserves streamed text once', () => {
  const parse = createPiParser();
  assert.deepEqual(parse({ type: 'message_start' }).map(e => e.type), ['progress']);
  assert.deepEqual(parse({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before' } }), [{ type: 'text.delta', text: 'before' }]);
  assert.equal(parse({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'before' }] } }).length, 0);
  assert.ok(parse({ type: 'agent_end' }).every(e => e.type !== 'turn.complete'));
  assert.ok(parse({ type: 'compaction_end' }).every(e => e.type !== 'turn.complete'));
  parse({ type: 'message_start' });
  assert.deepEqual(parse({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'after' }] } }), [{ type: 'text.delta', text: 'after' }]);
  assert.deepEqual(parse({ type: 'agent_settled', aborted: false }), [{ type: 'turn.complete', reason: 'success' }]);
});

test('Pi command keeps model/effort opaque, resumes explicitly, and hides MCP bearer', () => {
  const built = buildCommand('pi', { model: 'meta/muse-wonder-1.0', reasoning: 'max', sessionId: 'session', resume: true, prompt: 'hi', mcpServers: {
    buddy: { kind: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer private-test' }, required: true },
  } });
  try {
    assert.ok(built.argv.includes('--session'));
    assert.ok(built.argv.includes('meta/muse-wonder-1.0'));
    assert.ok(built.argv.includes('max'));
    assert.equal(built.argv.join(' ').includes('private-test'), false);
    const extension = readFileSync(built.argv[built.argv.lastIndexOf('--extension') + 1], 'utf8');
    assert.equal(extension.includes('private-test'), false);
    assert.ok(Object.values(built.env ?? {}).includes('Bearer private-test'));
  } finally { for (const path of built.ownedPaths) rmSync(path, { recursive: true, force: true }); }
});

// Run with the pinned Pi/SoL checkout's node_modules. This uses a real Pi CLI,
// native MCP/codemode and local faux provider; no owner auth or model calls.
const piRoot = process.env.AGENT_CLI_TEST_PI_ROOT;
test('real Pi native MCP/codemode: resume, adoption, required startup and tool receipts', { skip: !piRoot, timeout: 90000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-cli-real-pi-'));
  const solSource = process.env.AGENT_CLI_TEST_SOL_SOURCE || join(piRoot!, 'src/sol-pi/index.ts');
  const old = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, UNLEASHD_SOL_PI_EXTENSION: process.env.UNLEASHD_SOL_PI_EXTENSION };
  let called = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (!('id' in message)) { res.writeHead(204).end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'local', version: '1' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
        : message.method === 'tools/call'
          ? (assert.equal(message.params.name, 'echo'), called++, { content: [{ type: 'text', text: 'native receipt' }] })
          : {};
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const piCli = join(piRoot!, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
    writeFileSync(join(bin, 'sol-pi'), `#!/bin/sh\nexec "${process.execPath}" "${piCli}" --extension "${solSource}" "$@"\n`); chmodSync(join(bin, 'sol-pi'), 0o755);
    process.env.PATH = `${bin}:${old.PATH}`;
    process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
    process.env.UNLEASHD_SOL_PI_EXTENSION = solSource;
    mkdirSync(join(root, 'agent'));
    writeFileSync(join(root, 'agent', 'sol-pi.json'), JSON.stringify({ version: 1, actionFusion: true, observationPack: true, evidencePreservingReducer: true, onlineContextCompact: true, cacheWriteReadRatio: 12.5 }));
    const provider = join(root, 'provider.mjs');
    const fauxPath = join(piRoot!, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js');
    writeFileSync(provider, `
import { appendFileSync } from 'node:fs';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(fauxPath)};
export default pi => {
  const faux = fauxProvider({ provider: 'test', api: 'test-api', models: [{ id: 'probe', contextWindow: 200000, maxTokens: 4096 }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('codemode', { code: 'const r = await tools.mcp__buddy__echo({text:"hello"}); text(r);' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('done'),
  ]);
  for (const method of ['stream', 'streamSimple']) {
    const original = faux.provider[method];
    faux.provider[method] = (...args) => { appendFileSync(${JSON.stringify(join(root, 'model-calls'))}, 'call\\n'); return original(...args); };
  }
  pi.registerProvider(faux.provider);
  pi.on('before_agent_start', async event => { if (event.prompt === 'hang') await new Promise(resolve => setTimeout(resolve, 30000)); });
};`);
    const port = (server.address() as { port: number }).port;
    const request = { harness: 'pi' as const, mode: 'conversation' as const, cwd: root, model: 'test/probe', prompt: 'first', reasoningEffort: 'off', extraArgs: ['--offline', '--no-skills', '--no-context-files', '--extension', provider],
      mcpServers: { buddy: { kind: 'http' as const, url: `http://127.0.0.1:${port}/mcp`, required: true } } };
    const first = executeCommand({ ...request, sessionId: '09d78e5f-cd0a-471f-9f0a-d54656c7b2ae', journalDir: join(root, 'journal') });
    const events: UnifiedAgentEvent[] = [];
    for await (const event of first.events) events.push(event);
    const completion = await first.completed;
    assert.equal(completion.reason, 'success', JSON.stringify(events));
    assert.ok(called > 0, 'native MCP tool must actually run');
    assert.ok(existsSync(join(root, 'model-calls')), 'the provider-call observer must work');
    assert.ok(events.some(e => e.type === 'tool.result' && JSON.stringify(e.output).includes('native receipt')));
    assert.ok(events.some(e => e.type === 'tool.use' && e.name === 'mcp__buddy__echo'));
    assert.ok(events.some(e => e.type === 'tool.result'), 'native codemode receipt survives');
    const adopted = attachExecution(join(root, 'journal'));
    const replay = []; for await (const e of adopted.events) replay.push(e);
    assert.deepEqual(replay.filter(e => e.type === 'text.delta'), events.filter(e => e.type === 'text.delta'));
    await adopted.completed;
    const resumed = executeCommand({ ...request, resumeSessionId: completion.sessionId, prompt: 'second' });
    for await (const _event of resumed.events) {}
    assert.equal((await resumed.completed).sessionId, completion.sessionId);
    const cancelling = executeCommand({ ...request, prompt: 'hang' });
    for await (const event of cancelling.events) { if (event.type === 'session.started') cancelling.stop(); }
    assert.equal((await cancelling.completed).reason, 'killed');
    rmSync(join(root, 'model-calls'), { force: true });
    const bad = executeCommand({ ...request, mcpServers: { buddy: { kind: 'http', url: 'http://127.0.0.1:1/mcp', required: true } } });
    const errors = []; for await (const event of bad.events) errors.push(event);
    assert.equal((await bad.completed).reason, 'error');
    assert.equal(existsSync(join(root, 'model-calls')), false, 'a missing required MCP must prevent provider execution');
    assert.ok(errors.some(e => e.type === 'stderr' && e.text.includes('required MCP startup')));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});
