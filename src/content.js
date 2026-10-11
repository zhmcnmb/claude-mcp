// Runs in the MAIN world; extension storage arrives from isolated-content.js.
import { MCPConnection } from './mcp-connection';
import { log, setStorage } from './utils';

let mcpServers = [];
let storageLoaded = false;
let storageReady;
const ready = new Promise(resolve => { storageReady = resolve; });
const connections = new Map();

function disconnect(name) {
  const current = connections.get(name);
  if (!current) return;
  current.connection.disconnect();
  current.port.close();
  connections.delete(name);
}

async function connectToMcpServer(name) {
  await ready;
  const server = mcpServers.find(server => server.name === name);
  if (!server) throw new Error('Unknown MCP server: ' + name);
  const previous = connections.get(name);
  if (previous?.connecting) return previous.connecting;
  disconnect(name);

  const { port1, port2 } = new MessageChannel();
  const connection = new MCPConnection(name, {
    connectionType: 'sse', transportType: 'stdio',
    url: server.url, command: server.command, args: server.args, env: server.env,
  });
  const current = { connection, port: port1 };
  connections.set(name, current);
  port1.onmessage = async ({ data }) => {
    const reply = await connection.sendRequest(data);
    if (reply?.error && data.id !== undefined) {
      port1.postMessage({ jsonrpc: '2.0', id: data.id, error: reply.error });
    }
  };
  port1.start();
  current.connecting = (async () => {
    try {
      await connection.connect(message => port1.postMessage(message));
      if (connections.get(name) !== current) throw new Error('MCP connection was replaced');
      window.postMessage({
        source: 'main-content', type: 'mcp-server-connected', serverName: name,
      }, '*', [port2]);
      log('[MCP Client] Connected to ' + name);
    } catch (error) {
      if (connections.get(name) === current) disconnect(name);
      port2.close();
      throw error;
    } finally {
      current.connecting = null;
    }
  })();
  return current.connecting;
}

// Claude requests a new transport when its chat UI mounts again after navigation.
// A one-time mcp-server-connected event cannot restore tools in that new UI.
const bindings = window.claudeAppBindings ??= {};
bindings.listMcpServers ??= async () => {
  await ready;
  return mcpServers.map(server => server.name);
};
bindings.connectToMcpServer ??= connectToMcpServer;

// The RPC chat omits local MCP definitions unless this page advertises a client
// with app bindings. Advertise the MCP-capable client interface on this page.
// shortcut: this marker depends on Claude's private client contract; revisit when it changes.
const userAgent = window.navigator.userAgent;
if (!/claude(nest|gov)?[/]/i.test(userAgent)) {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    get: () => userAgent + ' Claude/0.14.0',
  });
}

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.source !== 'isolated-content') return;
  if (event.data.type === 'mcp-ext-storage-updated') {
    setStorage(event.data.data);
  } else if (event.data.type === 'mcp-servers-updated') {
    if (!Array.isArray(event.data?.data?.servers)) return;
    const previousNames = mcpServers.map(server => server.name);
    mcpServers = event.data.data.servers;
    for (const name of connections.keys()) disconnect(name);
    const wasLoaded = storageLoaded;
    storageLoaded = true;
    storageReady();
    if (wasLoaded) {
      for (const name of new Set([...previousNames, ...mcpServers.map(server => server.name)])) {
        window.postMessage({
          source: 'main-content', type: 'mcp-server-auto-reconnect', serverName: name,
        }, '*');
      }
    }
  }
});

window.addEventListener('pagehide', () => {
  for (const name of connections.keys()) disconnect(name);
});
