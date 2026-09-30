#!/usr/bin/env node
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getWorkspace, setWorkspace, toolDefs } from './tools.ts';
import { findAgentsFile, formatSkillsCatalog, scanSkills, skillSources } from './skills.ts';

/** 关键日志统一带时间戳，排障时能还原时间线。 */
function log(msg: string): void {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

// claude-local [工作区] [--port N] [--host H]
const args = process.argv.slice(2);
let workspaceArg: string | undefined;
let port = 8765;
let host = '127.0.0.1';
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) port = Number(args[++i]);
  else if (args[i] === '--host' && args[i + 1]) host = args[++i];
  else if (!args[i].startsWith('-')) workspaceArg = args[i];
}
setWorkspace(workspaceArg ?? process.cwd());
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`无效端口：${port}`);
  process.exit(1);
}

const skills = await scanSkills(getWorkspace());
const agentsFile = await findAgentsFile(getWorkspace());
const startupCatalog = formatSkillsCatalog(skills, agentsFile);
let lastCatalog = startupCatalog;

/** 每次 tools/list 都重新扫描，服务运行期间新增的 skill 无需重启即可生效。 */
async function currentCatalog(): Promise<string> {
  return formatSkillsCatalog(await scanSkills(getWorkspace()), await findAgentsFile(getWorkspace()));
}

function buildServer(): Server {
  const server = new Server(
    { name: 'claude-local', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: startupCatalog },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const catalog = await currentCatalog();
    if (catalog !== lastCatalog) {
      lastCatalog = catalog;
      server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {});
    }
    return {
      tools: toolDefs.map(({ handler, ...def }) => ({ ...def, description: `${def.description}\n\n${catalog}` })),
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
  const url = new URL(req.url ?? '/', `http://${host}`);
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/sse' || url.pathname === '/mcp')) {
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

httpServer.on('error', (e: any) => {
  console.error(e?.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。` : String(e?.message ?? e));
  process.exit(1);
});

httpServer.listen(port, host, () => {
  const sources = skillSources(getWorkspace());
  console.log(
    [
      'Claude Local MCP',
      '',
      `工作区: ${getWorkspace()}`,
      '工具: read, write, edit, bash',
      `Skill 来源:${sources.map((s) => `\n  - ${s}`).join('')}`,
      `发现 skills: ${skills.length}${skills.length ? `（${skills.map((s) => s.name).join(', ')}）` : ''}`,
      `AGENTS.md: ${agentsFile ?? '（无）'}`,
      '',
      `服务地址: http://${host}:${port}/sse`,
      '在 claude-mcp 浏览器扩展中添加此 URL（Name 随意，URL 如上，Command/Args/Env 留空）。',
    ].join('\n'),
  );
});
