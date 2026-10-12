import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

test('Claude can request a fresh MCP port after navigating to another conversation', async () => {
  const listeners = new Map();
  const messages = [];
  const connections = [];
  const window = {
    navigator: { userAgent: 'Mozilla/5.0 Chrome/147.0.14.0' },
    addEventListener: (type, handler) => listeners.set(type, handler),
    postMessage: (data, origin, ports) => messages.push({ data, ports }),
  };
  class Connection {
    constructor() { connections.push(this); }
    async connect(handler) { this.handler = handler; }
    async sendRequest(request) { this.handler({ jsonrpc: '2.0', id: request.id, result: { tools: ['read'] } }); }
    disconnect() { this.closed = true; }
  }
  class Channel {
    constructor() {
      this.port1 = { start() {}, close() {}, postMessage: data => { this.port2.onmessage?.({ data }); } };
      this.port2 = { close() {}, postMessage: data => { this.port1.onmessage?.({ data }); } };
    }
  }
  // Run the real entry point with transport dependencies substituted at its imports.
  const source = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  vm.runInNewContext(source, {
    window, MCPConnection: Connection, MessageChannel: Channel,
    log() {}, setStorage() {}, console, setTimeout,
  });
  assert.match(window.navigator.userAgent, /Claude\/0\.14\.0/,
    'the RPC client must recognize the local MCP capability before it mounts');
  assert.equal(typeof window.claudeAppBindings?.listMcpServers, 'function');
  const names = window.claudeAppBindings.listMcpServers();
  const update = servers => listeners.get('message')({
    source: window,
    data: { source: 'isolated-content', type: 'mcp-servers-updated', data: { servers } },
  });
  update([{ name: 'FileSSE', url: 'http://127.0.0.1:8765/sse' }]);
  assert.deepEqual(Array.from(await names), ['FileSSE']);

  await window.claudeAppBindings.connectToMcpServer('FileSSE');
  const first = messages.find(m => m.data.type === 'mcp-server-connected');
  assert.ok(first?.ports[0], 'the page receives a connected MessagePort');
  // The old page unmounts and closes its transport; the new page asks again.
  first.ports[0].close();
  messages.length = 0;
  await window.claudeAppBindings.connectToMcpServer('FileSSE');
  const second = messages.find(m => m.data.type === 'mcp-server-connected');
  assert.ok(second?.ports[0]);
  assert.notEqual(second.ports[0], first.ports[0]);
  assert.ok(connections[0].closed, 'the obsolete SSE session is closed');
  const reply = new Promise(resolve => { second.ports[0].onmessage = e => resolve(e.data); });
  second.ports[0].postMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual((await reply).result.tools, ['read']);

  connections[1].sendRequest = async () => ({ error: { code: 503, message: 'Unavailable' } });
  const errorReply = new Promise(resolve => { second.ports[0].onmessage = e => resolve(e.data); });
  second.ports[0].postMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call' });
  const error = await errorReply;
  assert.equal(error.id, 2);
  assert.equal(error.error.code, 503, 'HTTP failures reach the page instead of timing out');

  update([]);
  assert.deepEqual(Array.from(await window.claudeAppBindings.listMcpServers()), []);
  assert.ok(connections[1].closed, 'removing the server closes its connection');
  await assert.rejects(window.claudeAppBindings.connectToMcpServer('FileSSE'), /Unknown MCP server/);
});

test('existing native client bindings and user agent are preserved', () => {
  const listMcpServers = async () => ['Native'];
  const connectToMcpServer = async () => {};
  const userAgent = 'Mozilla/5.0 Claude/1.0.0';
  const window = {
    navigator: { userAgent },
    claudeAppBindings: { listMcpServers, connectToMcpServer },
    addEventListener() {},
  };
  const source = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  vm.runInNewContext(source, { window });
  assert.equal(window.navigator.userAgent, userAgent);
  assert.equal(window.claudeAppBindings.listMcpServers, listMcpServers);
  assert.equal(window.claudeAppBindings.connectToMcpServer, connectToMcpServer);
});
