// 端到端自检：在临时工作区启动 server.ts，像浏览器扩展一样驱动 legacy SSE 传输
//（GET /sse 拿 endpoint 事件 -> POST /messages 收发 JSON-RPC）。
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testShell } from './shell-test.mjs';
import { loadAgentsFiles } from './skills.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 18765;
const testRoot = path.resolve(here, '../temp/mcp-tests');
mkdirSync(testRoot, { recursive: true });
const testDir = mkdtempSync(path.join(testRoot, 'run-'));
const ws = path.join(testDir, 'project', 'workspace 中文');
const parentRules = '# Test parent rules\nPARENT_RULE_BODY\n';
const workspaceRules = '# Test project rules\nWORKSPACE_RULE_BODY\n';
mkdirSync(path.join(ws, '.pi', 'skills', 'demo-skill'), { recursive: true });
writeFileSync(
  path.join(ws, '.pi', 'skills', 'demo-skill', 'SKILL.md'),
  '---\nname: demo-skill\ndescription: Demo skill for the self-check.\n---\n# Demo\n',
);
mkdirSync(path.join(ws, '.pi', 'skills', 'dingtalk-calendar'), { recursive: true });
writeFileSync(
  path.join(ws, '.pi', 'skills', 'dingtalk-calendar', 'SKILL.md'),
  '---\nname: dingtalk-calendar\ndescription: 钉钉日历\n---\n',
);
writeFileSync(path.join(testDir, 'AGENTS.md'), '\uFEFF' + parentRules);
writeFileSync(path.join(ws, 'AGENTS.md'), workspaceRules);
const ponytailDirectory = path.join(testDir, 'ponytail');
const ponytailInstructions = path.join(ponytailDirectory, 'hooks', 'ponytail-instructions.js');
mkdirSync(path.dirname(ponytailInstructions), { recursive: true });
writeFileSync(path.join(ponytailDirectory, 'package.json'), '{"type":"commonjs"}');
writeFileSync(path.join(ponytailDirectory, 'hooks', 'ponytail-config.js'), 'exports.getDefaultMode = () => "full";');
writeFileSync(ponytailInstructions, 'exports.getPonytailInstructions = () => "PONYTAIL_TEST_V1";');

const executable = process.env.CLAUDE_LOCAL_TEST_EXECUTABLE;
const child = spawn(executable || process.execPath, [...(executable ? ['--server', '--self-test'] : [path.join(here, 'server.ts')]), ws, '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, PONYTAIL_DIR: ponytailDirectory, PONYTAIL_MODE: 'full', CLAUDE_LOCAL_TEST_DIR: path.join(testDir, 'electron-profile') },
});
process.once('exit', () => {
  child.kill();
  rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
assert.equal(init.result.instructions, undefined, '网页不消费初始化规则，不能重复交付全文');
const globalAgentsPath = path.join(homedir(), '.pi', 'agent', 'AGENTS.md');
const ack = await fetch(messagesUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
});
assert.equal(ack.status, 202);

// --- tools/list：恰好四个工具，read 集中注入规则/Ponytail/skills，其余工具不重复 ---
const list = await rpc('tools/list', {});
assert.deepEqual(
  list.result.tools.map((t) => t.name).sort(),
  ['bash', 'edit', 'read', 'write'],
);
const readTool = list.result.tools.find((t) => t.name === 'read');
assert.ok(readTool?.description.includes('demo-skill'), 'read 工具描述携带 skills catalog');
assert.ok(readTool?.description.includes('WORKSPACE_RULE_BODY'), 'read 工具描述集中注入工作区规则全文');
assert.ok(!readTool?.description.includes('dingtalk-calendar'), '钉钉相关技能已成功排除');
assert.ok(readTool.description.includes(parentRules), 'read 描述提供父级规则全文并去除 BOM');
assert.ok(readTool.description.includes(workspaceRules), 'read 描述提供工作区规则全文');
assert.ok(readTool.description.indexOf(parentRules) < readTool.description.indexOf(workspaceRules));
assert.match(readTool.description, /<project_instructions>/);
assert.ok(!readTool.description.includes('# Demo'), '技能正文仍按需读取');
assert.match(readTool.description, /PONYTAIL_TEST_V1/, '源码与打包入口都必须加载 Ponytail');
try {
  const globalRules = readFileSync(globalAgentsPath, 'utf8').replace(/^\uFEFF/, '');
  assert.ok(readTool.description.includes(globalRules), '个人通用规则仍完整保留');
  assert.ok(readTool.description.indexOf(globalRules) < readTool.description.indexOf(parentRules));
  const globalFiles = await loadAgentsFiles(path.dirname(globalAgentsPath));
  assert.equal(globalFiles.filter((file) => file.isGlobal).length, 1, '全局和祖先规则去重');
} catch (e) { if (e.code !== 'ENOENT') throw e; }

const otherTools = list.result.tools.filter((t) => t.name !== 'read');
assert.ok(
  otherTools.every((t) => !t.description.includes('demo-skill') && !t.description.includes('WORKSPACE_RULE_BODY')),
  '其余工具保持精炼，不重复注入 skills catalog 或规则正文（避免 Token 冗余）',
);
const bashTool = list.result.tools.find((t) => t.name === 'bash');
assert.ok(bashTool?.description.includes('rtk'), 'bash 工具描述携带 rtk 引导');

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
await toolCall('read', { path: 'dup.txt' });
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

// --- 参数校验不能把缺少 content/newText 当成删除指令 ---
const resultText = (result) => result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
const assertError = (result, pattern) => { assert.ok(result.isError, resultText(result)); assert.match(resultText(result), pattern); };
writeFileSync(path.join(ws, 'protected.txt'), 'KEEP\n');
await toolCall('read', { path: 'protected.txt' });
for (const [name, args] of [
  ['write', { path: 'protected.txt' }],
  ['write', { path: 'protected.txt', content: null }],
  ['edit', { path: 'protected.txt', oldText: 'KEEP' }],
  ['edit', { path: 'protected.txt', edits: [{ oldText: 'KEEP' }] }],
  ['edit', { path: 'protected.txt', oldText: '', newText: 'x' }],
  ['edit', { path: 'protected.txt', oldText: 'KEEP', newText: 'x', edits: [] }],
  ['read', { path: 'protected.txt', offset: 1.5 }],
  ['bash', { command: 'echo ignored', timeout: -1 }],
  ['write', { path: 'protected.txt', content: 'oops', typo: true }],
]) {
  assert.ok((await toolCall(name, args)).isError, `${name} 必须拒绝无效参数`);
  assert.equal(readFileSync(path.join(ws, 'protected.txt'), 'utf8'), 'KEEP\n');
}

// --- 原编码/BOM/行尾按字节保留，不可表示的新字符必须拒绝 ---
const fixtures = [
  ['utf8', Buffer.from('alpha=1\r\n中文\r\n'), Buffer.from('alpha=2\r\n中文\r\n'), 'UTF-8，CRLF'],
  ['utf8-bom', Buffer.from('\ufeffalpha=1\r\n中文\r\n'), Buffer.from('\ufeffalpha=2\r\n中文\r\n'), 'UTF-8 BOM，CRLF'],
  ['gbk', Buffer.from('616c7068613d310d0ad6d0cec40d0a', 'hex'), Buffer.from('616c7068613d320d0ad6d0cec40d0a', 'hex'), 'GBK，CRLF'],
  ['utf16le', Buffer.from('\ufeffalpha=1\r\n中文\r\n', 'utf16le'), Buffer.from('\ufeffalpha=2\r\n中文\r\n', 'utf16le'), 'UTF-16LE BOM，CRLF'],
  ['utf16be', Buffer.from('\ufeffalpha=1\r\n中文\r\n', 'utf16le').swap16(), Buffer.from('\ufeffalpha=2\r\n中文\r\n', 'utf16le').swap16(), 'UTF-16BE BOM，CRLF'],
];
for (const [name, before, after, format] of fixtures) {
  const file = `${name}.txt`;
  writeFileSync(path.join(ws, file), before);
  const shown = resultText(await toolCall('read', { path: file }));
  assert.match(shown, /中文/);
  assert.ok(shown.startsWith(`[文件格式：${format}]\n1: alpha=1`), shown);
  const result = await toolCall('edit', { path: file, oldText: 'alpha=1\n中文', newText: 'alpha=2\n中文' });
  assert.ok(!result.isError, resultText(result));
  assert.deepEqual(readFileSync(path.join(ws, file)), after, `${name} 局部编辑保留字节格式`);
  const overwritten = await toolCall('write', { path: file, content: 'alpha=1\n中文\n' });
  assert.ok(!overwritten.isError, resultText(overwritten));
  assert.deepEqual(readFileSync(path.join(ws, file)), before, `${name} 整体覆盖保留格式`);
}
const badCharacter = await toolCall('edit', { path: 'gbk.txt', oldText: 'alpha=1', newText: 'emoji=😀' });
assertError(badCharacter, /无法.*无损保存/);
assert.deepEqual(readFileSync(path.join(ws, 'gbk.txt')), fixtures[2][1]);
for (const bytes of [Buffer.from([0xff]), Buffer.from([0xff, 0xfe, 0x61]), Buffer.from([0, 1, 2, 3]), Buffer.from([0xff, 0xfe, 0, 0])]) {
  writeFileSync(path.join(ws, 'invalid-encoding.txt'), bytes);
  assert.ok((await toolCall('read', { path: 'invalid-encoding.txt' })).isError);
  assert.ok((await toolCall('write', { path: 'invalid-encoding.txt', content: 'replace' })).isError);
  assert.deepEqual(readFileSync(path.join(ws, 'invalid-encoding.txt')), bytes);
}
const mixed = 'a=1\r\nb=2\nc=3\r\nd=4';
writeFileSync(path.join(ws, 'mixed.txt'), mixed);
assert.match(resultText(await toolCall('read', { path: 'mixed.txt' })), /^\[文件格式：UTF-8，混合行尾\]/);
assert.ok(!(await toolCall('edit', { path: 'mixed.txt', oldText: 'a=1', newText: 'a=9\ninsert=1' })).isError);
assert.equal(readFileSync(path.join(ws, 'mixed.txt'), 'utf8'), 'a=9\r\ninsert=1\r\nb=2\nc=3\r\nd=4');
assertError(await toolCall('write', { path: 'mixed.txt', content: 'all\nchanged\n' }), /混合行尾/);
writeFileSync(path.join(ws, 'crlf-offsets.txt'), 'start\r\nA😀=1\r\nB=2\r\nend');
await toolCall('read', { path: 'crlf-offsets.txt' });
assert.ok(!(await toolCall('edit', { path: 'crlf-offsets.txt', edits: [
  { oldText: 'A😀=1\nB=2', newText: 'A😀=9\nB=8' },
  { oldText: 'end', newText: 'last\nline' },
] })).isError);
assert.equal(readFileSync(path.join(ws, 'crlf-offsets.txt'), 'utf8'), 'start\r\nA😀=9\r\nB=8\r\nlast\r\nline');
writeFileSync(path.join(ws, 'ambiguous.txt'), 'aaa');
await toolCall('read', { path: 'ambiguous.txt' });
assertError(await toolCall('edit', { path: 'ambiguous.txt', oldText: 'aa', newText: 'x' }), /匹配到 2 处/);

// --- 未读/过期快照拒绝覆盖；并发请求不能覆盖另一个请求的结果 ---
writeFileSync(path.join(ws, 'unread.txt'), 'original');
assertError(await toolCall('read', { path: 'unread.txt', offset: 100 }), /超出文件范围/);
assertError(await toolCall('write', { path: 'unread.txt', content: 'lost' }), /先用 read/);
assertError(await toolCall('edit', { path: 'unread.txt', oldText: 'original', newText: 'lost' }), /先用 read/);
await toolCall('read', { path: 'unread.txt' });
writeFileSync(path.join(ws, 'unread.txt'), 'original\nexternal');
assertError(await toolCall('edit', { path: 'unread.txt', oldText: 'original', newText: 'lost' }), /已变化/);
assertError(await toolCall('write', { path: 'unread.txt', content: 'lost' }), /已变化/);
assert.equal(readFileSync(path.join(ws, 'unread.txt'), 'utf8'), 'original\nexternal');
unlinkSync(path.join(ws, 'unread.txt'));
assertError(await toolCall('write', { path: 'unread.txt', content: 'resurrect' }), /已变化/);
assert.ok(!existsSync(path.join(ws, 'unread.txt')));

const second = new Client({ name: 'second-session', version: '1' });
await second.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)));
await second.listTools();
try {
  assertError(await second.callTool({ name: 'write', arguments: { path: 'protected.txt', content: 'lost' } }), /先用 read/);
  writeFileSync(path.join(ws, 'concurrent.txt'), 'a=1\nb=1\n');
  await toolCall('read', { path: 'concurrent.txt' });
  await second.callTool({ name: 'read', arguments: { path: 'concurrent.txt' } });
  const concurrent = await Promise.all([
    toolCall('edit', { path: 'concurrent.txt', oldText: 'a=1', newText: 'a=2' }),
    second.callTool({ name: 'edit', arguments: { path: 'concurrent.txt', oldText: 'b=1', newText: 'b=2' } }),
  ]);
  assert.equal(concurrent.filter((result) => result.isError).length, 1, '两个快照只能有一个先写成功');
  assert.match(readFileSync(path.join(ws, 'concurrent.txt'), 'utf8'), /^(a=2\nb=1|a=1\nb=2)\n$/);
} finally { await second.close(); }
writeFileSync(path.join(ws, 'same-session.txt'), 'a=1\nb=1\n');
await toolCall('read', { path: 'same-session.txt' });
const sameSession = await Promise.all([
  toolCall('edit', { path: 'same-session.txt', oldText: 'a=1', newText: 'a=2' }),
  toolCall('edit', { path: 'same-session.txt', oldText: 'b=1', newText: 'b=2' }),
]);
assert.equal(sameSession.filter((result) => result.isError).length, 1, '同连接并发调用也使用请求开始时的快照');

// --- 子目录规则、热更新和命令 cwd：规则交付不应先执行副作用 ---
mkdirSync(path.join(ws, 'nested'));
const nestedRules = path.join(ws, 'nested', 'AGENTS.md');
writeFileSync(nestedRules, '# Nested\nNESTED_RULE_V1\n');
const versionOf = (result) => resultText(result).match(/contextVersion: ([a-f0-9]{64})/)?.[1];
const nestedWrite = { path: 'nested/new.txt', content: 'a=1\n' };
const gated = await toolCall('write', nestedWrite);
assertError(gated, /CONTEXT_REQUIRED/);
assert.match(resultText(gated), /NESTED_RULE_V1/);
assert.ok(!existsSync(path.join(ws, 'nested', 'new.txt')));
assertError(await toolCall('write', nestedWrite), /CONTEXT_REQUIRED/);
const nestedVersion = versionOf(gated);
assert.ok(nestedVersion);
assert.ok(!(await toolCall('write', { ...nestedWrite, contextVersion: nestedVersion })).isError);
writeFileSync(nestedRules, '# Nested\nNESTED_RULE_V2\n');
const updated = await toolCall('read', { path: 'nested/new.txt' });
assert.match(resultText(updated), /NESTED_RULE_V2/);
assert.ok(!(resultText(await toolCall('read', { path: 'nested/new.txt' })).includes('NESTED_RULE_V2')), '相同连接/版本不重复附加正文');
assertError(await toolCall('edit', { path: 'nested/new.txt', oldText: 'a=1', newText: 'a=2', contextVersion: nestedVersion }), /CONTEXT_REQUIRED/);
assert.ok(!(await toolCall('edit', { path: 'nested/new.txt', oldText: 'a=1', newText: 'a=2', contextVersion: versionOf(updated) })).isError);
symlinkSync(path.join(ws, 'nested'), path.join(ws, 'alias'), 'junction');
await toolCall('read', { path: 'alias/new.txt' });
writeFileSync(path.join(ws, 'nested', 'new.txt'), 'a=3\n');
assertError(await toolCall('edit', { path: 'nested/new.txt', oldText: 'a=3', newText: 'lost', contextVersion: versionOf(updated) }), /已变化/);
await toolCall('read', { path: 'nested/new.txt' });
assert.ok(!(await toolCall('edit', { path: 'alias/new.txt', oldText: 'a=3', newText: 'a=4', contextVersion: versionOf(updated) })).isError, '路径别名共享真实文件的读取版本和目录规则');
const commandArgs = { cwd: 'nested/deeper', command: 'node -e "require(\'fs\').writeFileSync(\'marker.txt\',\'ok\')"' };
mkdirSync(path.join(ws, 'nested', 'deeper'));
writeFileSync(path.join(ws, 'nested', 'deeper', 'AGENTS.md'), '# Deeper\nDEEPER_RULE\n');
const deeperGate = await toolCall('bash', commandArgs);
assertError(deeperGate, /CONTEXT_REQUIRED/);
assert.match(resultText(deeperGate), /DEEPER_RULE/);
assert.ok(!resultText(deeperGate).includes('NESTED_RULE_V2'), '只交付尚未确认的规则，不重发已确认正文');
assert.ok(!resultText(deeperGate).includes('WORKSPACE_RULE_BODY'));
assert.ok(!existsSync(path.join(ws, 'nested', 'deeper', 'marker.txt')));
assert.match(resultText(await toolCall('bash', { ...commandArgs, contextVersion: versionOf(deeperGate) })), /exitCode: 0/);
assert.equal(readFileSync(path.join(ws, 'nested', 'deeper', 'marker.txt'), 'utf8'), 'ok');
assert.ok(!(await toolCall('bash', commandArgs)).isError, '已确认的规则不要求每次回传版本');
assert.ok(!(await toolCall('bash', { cwd: 'sub', command: 'echo ok' })).isError, '没有新规则的目录不拦截');
unlinkSync(nestedRules);
const removed = await toolCall('read', { path: 'nested/new.txt' });
assert.ok(!resultText(removed).includes('NESTED_RULE_V2'), '删除的规则不继续交付');
writeFileSync(path.join(ws, 'AGENTS.md'), workspaceRules + 'WORKSPACE_RULE_UPDATED\n');
const hot = await toolCall('read', { path: 'protected.txt' });
assert.match(resultText(hot), /WORKSPACE_RULE_UPDATED/, '无需 tools/list 即可收到规则变更');
assertError(await toolCall('write', { path: 'protected.txt', content: '' }), /CONTEXT_REQUIRED/);
assert.ok(!(await toolCall('write', { path: 'protected.txt', content: '', contextVersion: versionOf(hot) })).isError, '明确的空字符串仍可用于清空');
assert.equal(readFileSync(path.join(ws, 'protected.txt'), 'utf8'), '');
writeFileSync(ponytailInstructions, 'exports.getPonytailInstructions = () => "PONYTAIL_TEST_V2";');
const ponytailUpdated = await toolCall('read', { path: 'protected.txt' });
assert.match(resultText(ponytailUpdated), /PONYTAIL_TEST_V2/, '运行期间变更 Ponytail 正文不能被 require 缓存掩盖');
assert.ok(!resultText(ponytailUpdated).includes('PONYTAIL_TEST_V1'));

// --- skill 热重扫：启动后新增的 skill 必须出现在新的 tools/list 里 ---
mkdirSync(path.join(ws, '.pi', 'skills', 'late-skill'), { recursive: true });
writeFileSync(path.join(ws, '.pi', 'skills', 'late-skill', 'SKILL.md'), '---\nname: late-skill\ndescription: Added after startup.\n---\n');
const relist = await rpc('tools/list', {});
const reReadTool = relist.result.tools.find((t) => t.name === 'read');
assert.ok(
  reReadTool?.description.includes('late-skill'),
  'tools/list 每次调用都会重新扫描 skills 并体现在 read 工具描述中',
);

// --- 大请求体：超过 SDK 旧 4MB 上限的 Write 也必须打通（之前会静默卡死对话） ---
const big = 'x'.repeat(5 * 1024 * 1024);
const bigWrite = await toolCall('write', { path: 'big.txt', content: big });
assert.ok(!bigWrite.isError, '超过 4MB 的 Write 请求体不被拒绝');
assert.equal(readFileSync(path.join(ws, 'big.txt'), 'utf8').length, big.length);

// --- replaceAll 与编辑反馈 ---
await toolCall('write', { path: 'replace-all.txt', content: '中文 target\r\n中文 target\r\n' });
assertError(await toolCall('edit', { path: 'replace-all.txt', oldText: 'target', newText: 'done' }), /2 处/);
const all = await toolCall('edit', { path: 'replace-all.txt', oldText: 'target', newText: 'done', replaceAll: true });
assert.match(resultText(all), /2 处/);
assert.match(resultText(all), /1: 中文 done/);
assert.equal(readFileSync(path.join(ws, 'replace-all.txt'), 'utf8'), '中文 done\r\n中文 done\r\n');
await toolCall('write', { path: 'overlap-all.txt', content: 'aaa' });
assertError(await toolCall('edit', { path: 'overlap-all.txt', oldText: 'aa', newText: 'b', replaceAll: true }), /重叠/);
assert.equal(readFileSync(path.join(ws, 'overlap-all.txt'), 'utf8'), 'aaa');
assertError(await toolCall('edit', { path: 'replace-all.txt', oldText: '中文 done\nmissing', newText: 'x' }), /候选位置/);

await testShell(toolCall, ws, `http://127.0.0.1:${port}/sse`);

// --- 规则文件不可读取时必须报错，不能静默跳过 ---
const invalidRulesDir = path.join(testDir, 'invalid-rules');
mkdirSync(path.join(invalidRulesDir, 'AGENTS.md'), { recursive: true });
await assert.rejects(loadAgentsFiles(invalidRulesDir), /无法读取规则文件/);

console.log('PASS：claude-local 端到端自检全部通过');
process.exit(0);
