import http from 'node:http';
import { promises as fs } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getWorkspace, setWorkspace, toolDefs } from './tools.ts';
import {
  formatAgentsInstructions,
  formatSkillsCatalog,
  loadAgentsFiles,
  loadPonytailInstructions,
  scanSkills,
  skillSources,
} from './skills.ts';
export async function startServer({ workspace, host = '127.0.0.1', port = 8765, endpoint = '/sse', onLog = console.error }: {
  workspace: string;
  host?: string;
  port?: number;
  endpoint?: string;
  onLog?: (message: string) => void;
}) {
  const log = (message: string) => onLog(`[${new Date().toISOString()}] ${message}`);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`无效端口：${port}`);
  if (!(await fs.stat(workspace)).isDirectory()) throw new Error(`工作区不是目录：${workspace}`);
  setWorkspace(workspace);
  const skills = await scanSkills(getWorkspace());
  const agentsFiles = await loadAgentsFiles(getWorkspace());
  const ponytailInstructions = await loadPonytailInstructions();
  const startupCatalog = formatSkillsCatalog(skills);
  const startupInstructions = [
    formatAgentsInstructions(agentsFiles),
    ponytailInstructions,
    startupCatalog,
  ].filter(Boolean).join('\n\n');
  let lastInstructions = startupInstructions;

  /** 每次 tools/list 都重新扫描，服务运行期间新增的 skill 或规则变更无需重启即可生效。 */
  async function currentInstructions(): Promise<string> {
    const [scannedSkills, scannedAgents, scannedPonytail] = await Promise.all([
      scanSkills(getWorkspace()),
      loadAgentsFiles(getWorkspace()),
      loadPonytailInstructions(),
    ]);
    const catalog = formatSkillsCatalog(scannedSkills);
    const agents = formatAgentsInstructions(scannedAgents);
    return [agents, scannedPonytail, catalog].filter(Boolean).join('\n\n');
  }

  function buildServer(): Server {
    const server = new Server(
      { name: 'claude-local', version: '0.1.0' },
      { capabilities: { tools: {} }, instructions: startupInstructions },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const instructions = await currentInstructions();
      if (instructions !== lastInstructions) {
        lastInstructions = instructions;
        server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {});
      }
      log(`tools/list 被调用，返回 ${toolDefs.length} 个工具`);
      return {
        tools: toolDefs.map(({ handler, ...def }) => ({
          ...def,
          description: def.name === 'read' ? `${def.description}\n\n${instructions}` : def.description,
        })),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const def = toolDefs.find((t) => t.name === req.params.name);
      const start = Date.now();
      let result;
      if (!def) {
        result = { content: [{ type: 'text' as const, text: `未知工具：${req.params.name}` }], isError: true };
      } else {
        try {
          result = await def.handler(req.params.arguments as never);
        } catch (e: any) {
          result = { content: [{ type: 'text' as const, text: String(e?.message ?? e) }], isError: true };
        }
      }
      log(`tools/call ${req.params.name} ${result.isError ? '返回错误' : '完成'}，耗时 ${Date.now() - start}ms`);
      return result;
    });
    server.oninitialized = () => log('客户端初始化完成（initialize 握手成功）');
    return server;
  }

  // 浏览器扩展实际使用的是 legacy MCP SSE 传输（2024-11-05）：
  // GET /sse 建立 SSE 流并下发 endpoint 事件；POST /messages?sessionId=... 回 202，响应经 SSE 流推送。
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer((req, res) => {
    // https://claude.ai 页面跨源访问回环地址：必须放行 CORS 与 Private Network Access 预检。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && (url.pathname === endpoint || url.pathname === '/' || url.pathname === '/sse' || url.pathname === '/mcp')) {
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      const server = buildServer();
      // 长时间执行 bash 时 SSE 上一字节都没有，定期发注释行防止连接被当作死连接断开
      const keepalive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* 连接已断开，close 事件会清理 */
        }
      }, 25_000);
      log(`SSE 连接建立，sessionId=${transport.sessionId}`);
      res.on('close', () => {
        clearInterval(keepalive);
        transports.delete(transport.sessionId);
        server.close().catch(() => {});
        log(`SSE 连接关闭，sessionId=${transport.sessionId}`);
      });
      server.connect(transport).catch(() => transports.delete(transport.sessionId));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const id = url.searchParams.get('sessionId') ?? url.searchParams.get('session_id');
      const transport = id ? transports.get(id) : undefined;
      if (!transport) {
        log(`POST 到未知会话：${id}`);
        res.writeHead(404);
        res.end(`未知会话：${id}`);
        return;
      }
      // 请求体由自己读取：SDK 默认 4MB 上限，而扩展会忽略 POST 级错误，
      // 超限的工具调用（如大文件 Write）会变成页面永远等不到结果的黑洞
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          log(`POST 消息不是合法 JSON（${body.length} 字符）`);
          res.writeHead(400);
          res.end('消息不是合法 JSON');
          return;
        }
        transport.handlePostMessage(req, res, parsed).catch((e) => {
          log(`POST 处理失败：${e?.message ?? e}`);
          if (!res.headersSent) res.writeHead(400);
          res.end(String(e?.message ?? e));
        });
      });
      return;
    }
    res.writeHead(404);
    res.end('未找到');
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (e: any) => reject(new Error(e?.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。请先关闭已运行的服务。` : String(e?.message ?? e))));
    httpServer.listen(port, host, resolve);
  });

  const addressHost = host.includes(':') ? `[${host}]` : host;
  const serviceUrl = `http://${addressHost}:${port}${endpoint}`;
  const sources = skillSources(getWorkspace());
  log(
    [
      'Claude Local MCP',
      '',
      `工作区: ${getWorkspace()}`,
      '工具: read, write, edit, bash',
      `Skill 来源:${sources.map((s) => `\n  - ${s}`).join('')}`,
      `发现 skills: ${skills.length}${skills.length ? `（${skills.map((s) => s.name).join(', ')}）` : ''}`,
      `AGENTS.md（已加载）: ${agentsFiles.length ? agentsFiles.map((file) => file.path).join(', ') : '（无）'}`,
      '',
      `服务地址: ${serviceUrl}`,
      '在 claude-mcp 浏览器扩展中添加此 URL（Name 随意，URL 如上，Command/Args/Env 留空）。',
    ].join('\n'),
  );
  return {
    url: serviceUrl,
    workspace: getWorkspace(),
    async stop() {
      await Promise.all([...transports.values()].map((transport) => transport.close()));
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    },
  };
}
