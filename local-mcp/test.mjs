// 端到端自检：在临时工作区启动 server.ts，像浏览器扩展一样驱动 legacy SSE 传输
//（GET /sse 拿 endpoint 事件 -> POST /messages 收发 JSON-RPC）。
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 18765;
const ws = mkdtempSync(path.join(tmpdir(), 'claude-local-test-'));
mkdirSync(path.join(ws, '.pi', 'skills', 'demo-skill'), { recursive: true });
writeFileSync(
  path.join(ws, '.pi', 'skills', 'demo-skill', 'SKILL.md'),
  '---\nname: demo-skill\ndescription: Demo skill for the self-check.\n---\n# Demo\n',
);
writeFileSync(path.join(ws, 'AGENTS.md'), '# Test project rules\n');

const child = spawn(process.execPath, [path.join(here, 'server.ts'), ws, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start in 10s')), 10_000);
  child.stdout.on('data', (d) => {
    if (String(d).includes('服务地址: http')) {
      clearTimeout(t);
      resolve();
    }
  });
  child.on('exit', (code) => reject(new Error(`server exited early: ${code}`)));
});

// --- 极简 SSE 客户端 ---
const sseRes = await fetch(`http://127.0.0.1:${port}/sse`);
assert.equal(sseRes.status, 200);
const reader = sseRes.body.getReader();
const decoder = new TextDecoder();
let buf = '';
const events = [];
const waiters = [];
function dispatch(ev) {
  for (let i = 0; i < waiters.length; i++) {
    if (waiters[i].pred(ev)) {
      waiters.splice(i, 1)[0].resolve(ev);
      return;
    }
  }
  events.push(ev);
}
function nextEvent(pred, label) {
  const idx = events.findIndex(pred);
  if (idx >= 0) return Promise.resolve(events.splice(idx, 1)[0]);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 10_000);
    waiters.push({ pred, resolve: (ev) => (clearTimeout(t), resolve(ev)) });
  });
}
(async function pump() {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) ev.event = line.slice(7);
        else if (line.startsWith('data: ')) ev.data = line.slice(6);
      }
      if (ev.event) dispatch(ev);
    }
  }
})();

const endpoint = await nextEvent((e) => e.event === 'endpoint', 'endpoint event');
const messagesUrl = new URL(endpoint.data, `http://127.0.0.1:${port}`);
assert.ok(messagesUrl.searchParams.get('sessionId'), 'endpoint carries sessionId');

let nextId = 1;
async function rpc(method, params) {
  const id = nextId++;
  const res = await fetch(messagesUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(res.status, 202, `${method} POST accepted`);
  const msg = await nextEvent((e) => {
    if (e.event !== 'message') return false;
    try {
      return JSON.parse(e.data).id === id;
    } catch {
      return false;
    }
  }, `${method} response`);
  return JSON.parse(msg.data);
}
const toolCall = async (name, args) =>
  (await rpc('tools/call', { name, arguments: args })).result;

// --- 协议握手 ---
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'self-check', version: '0.0.0' },
});
assert.equal(init.result.serverInfo.name, 'claude-local');
assert.match(init.result.instructions, /demo-skill/, 'instructions carry the skills catalog');
assert.match(init.result.instructions, /项目规则文件: .*AGENTS\.md/, 'instructions 指向工作区 AGENTS.md');
const ack = await fetch(messagesUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
});
assert.equal(ack.status, 202);

// --- tools/list：恰好四个工具，描述里都带 skills catalog ---
const list = await rpc('tools/list', {});
assert.deepEqual(
  list.result.tools.map((t) => t.name).sort(),
  ['bash', 'edit', 'read', 'write'],
);
assert.ok(
  list.result.tools.every((t) => t.description.includes('demo-skill')),
  'every tool description carries the skills catalog',
);

// --- bash ---
const echo = await toolCall('bash', { command: 'node -e "console.log(6 * 7)"' });
assert.match(echo.content[0].text, /exitCode: 0/);
assert.match(echo.content[0].text, /42/);
const failing = await toolCall('bash', { command: 'node -e "process.exit(3)"' });
assert.match(failing.content[0].text, /exitCode: 3/);
assert.ok(!failing.isError, 'non-zero exit is a result, not a tool error');

// --- write / read / edit 往返 ---
await toolCall('write', { path: 'sub/dir/hello.txt', content: 'alpha\nbeta\ngamma\n' });
const readBack = await toolCall('read', { path: 'sub/dir/hello.txt' });
assert.equal(readBack.content[0].text, '1: alpha\n2: beta\n3: gamma');
const readSlice = await toolCall('read', { path: 'sub/dir/hello.txt', offset: 2, limit: 1 });
assert.equal(readSlice.content[0].text, '2: beta\n[已截断 — 共 3 行，用 offset/limit 继续读取]');
await toolCall('edit', { path: 'sub/dir/hello.txt', oldText: 'beta', newText: 'BETA' });
assert.equal(readFileSync(path.join(ws, 'sub/dir/hello.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
writeFileSync(path.join(ws, 'dup.txt'), 'x x');
const dup = await toolCall('edit', { path: 'dup.txt', oldText: 'x', newText: 'y' });
assert.ok(dup.isError && /匹配到 2 处/.test(dup.content[0].text), '非唯一 oldText 被拒绝');
const missing = await toolCall('edit', { path: 'dup.txt', oldText: 'zzz', newText: 'y' });
assert.ok(missing.isError && /未找到匹配/.test(missing.content[0].text), '找不到的 oldText 被拒绝');
const unknown = await toolCall('nope', {});
assert.ok(unknown.isError, '未知工具被拒绝');

// --- 绝对路径 + bash 的工作目录 ---
await toolCall('write', { path: path.join(ws, 'abs.txt'), content: 'abs' });
const absRead = await toolCall('read', { path: path.join(ws, 'abs.txt') });
assert.equal(absRead.content[0].text, '1: abs');
const cwdOut = await toolCall('bash', { command: 'node -e "console.log(process.cwd())"' });
assert.match(cwdOut.content[0].text.replace(/\\/g, '/'), new RegExp(ws.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

// --- 读取图片 ---
const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
writeFileSync(path.join(ws, 'pixel.png'), Buffer.from(pngB64, 'base64'));
const img = await toolCall('read', { path: 'pixel.png' });
assert.deepEqual(img.content[0], { type: 'image', data: pngB64, mimeType: 'image/png' });

// --- 批量编辑：针对原文件原子生效 ---
await toolCall('write', { path: 'multi.txt', content: 'one\ntwo\nthree\n' });
const batch = await toolCall('edit', {
  path: 'multi.txt',
  edits: [
    { oldText: 'one', newText: '1' },
    { oldText: 'three', newText: '3' },
  ],
});
assert.ok(!batch.isError);
assert.equal(readFileSync(path.join(ws, 'multi.txt'), 'utf8'), '1\ntwo\n3\n');
const badBatch = await toolCall('edit', {
  path: 'multi.txt',
  edits: [
    { oldText: 'two', newText: '2' },
    { oldText: 'zzz', newText: '?' },
  ],
});
assert.ok(badBatch.isError && /未找到匹配/.test(badBatch.content[0].text));
assert.equal(readFileSync(path.join(ws, 'multi.txt'), 'utf8'), '1\ntwo\n3\n', '失败的批量编辑不写入任何内容');
const overlap = await toolCall('edit', {
  path: 'multi.txt',
  edits: [
    { oldText: '1\ntwo', newText: 'x' },
    { oldText: 'two\n3', newText: 'y' },
  ],
});
assert.ok(overlap.isError && /重叠/.test(overlap.content[0].text), '重叠的批量编辑被拒绝');

// --- skill 热重扫：启动后新增的 skill 必须出现在新的 tools/list 里 ---
mkdirSync(path.join(ws, '.pi', 'skills', 'late-skill'), { recursive: true });
writeFileSync(path.join(ws, '.pi', 'skills', 'late-skill', 'SKILL.md'), '---\nname: late-skill\ndescription: Added after startup.\n---\n');
const relist = await rpc('tools/list', {});
assert.ok(
  relist.result.tools.every((t) => t.description.includes('late-skill')),
  'tools/list 每次调用都会重新扫描 skills',
);

// --- 大请求体：超过 SDK 旧 4MB 上限的 Write 也必须打通（之前会静默卡死对话） ---
const big = 'x'.repeat(5 * 1024 * 1024);
const bigWrite = await toolCall('write', { path: 'big.txt', content: big });
assert.ok(!bigWrite.isError, '超过 4MB 的 Write 请求体不被拒绝');
assert.equal(readFileSync(path.join(ws, 'big.txt'), 'utf8').length, big.length);

child.kill();
rmSync(ws, { recursive: true, force: true });
console.log('PASS：claude-local 端到端自检全部通过');
process.exit(0);
