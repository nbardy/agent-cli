import fs from 'node:fs';

// Minimal newline-delimited JSON-RPC MCP server for live muse tests.
// No dependencies: implements just initialize / tools/list / tools/call.
const LOG = process.env.MUSE_MCP_ECHO_LOG ?? '';

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handleMessage(JSON.parse(line));
      } catch {
        // Ignore malformed input; the client owns framing.
      }
    }
    index = buffer.indexOf('\n');
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleMessage(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'muse-mcp-echo', version: '0.0.1' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo text back. Always call this tool when asked to echo.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    });
    return;
  }
  if (message.method === 'tools/call') {
    const text = message.params?.arguments?.text ?? '';
    if (LOG) fs.appendFileSync(LOG, `echo:${text}\n`);
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: `echo:${text}` }] },
    });
  }
  // Notifications (e.g. notifications/initialized) need no response.
}
