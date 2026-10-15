import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createShell } from './shell.ts';

export async function testShell(call, workspace, url) {
  const text = (result) => { assert.ok(!result.isError, JSON.stringify(result)); return result.content.map((c) => c.text ?? '').join('\n'); };
  const field = (output, key) => output.match(new RegExp(`^${key}: (.+)$`, 'm'))?.[1];
  const command = (name) => `node "${path.join(workspace, name)}"`;
  const run = async (args) => text(await call('bash', args));
  const gone = (pid) => { assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' }, `进程 ${pid} 必须退出`); };

  await fs.writeFile(path.join(workspace, 'large-output.cjs'), `const line = '中文😀'.repeat(400) + '\\n'; for (let i=0;i<5000;i++) process.stdout.write(line); process.stderr.write('错误中文😀\\n');`);
  const output = await run({ command: command('large-output.cjs') });
  assert.equal(field(output, 'exitCode'), '0', '大输出不能触发 maxBuffer 失败');
  const log = await fs.readFile(field(output, 'stdoutPath'), 'utf8');
  assert.equal(log, ('中文😀'.repeat(400) + '\n').repeat(5000));
  assert.ok(Buffer.byteLength(log) > 16 * 1024 * 1024);
  assert.equal(await fs.readFile(field(output, 'stderrPath'), 'utf8'), '错误中文😀\n');
  assert.ok(!output.includes('\ufffd'), 'UTF-8 截断不能拆分字符');
  assert.ok(Buffer.byteLength(output) < 110000, '返回内容受限，完整输出留在文件');
  assert.match(text(await call('read', { path: field(output, 'stdoutPath'), offset: 4999, limit: 2 })), /4999: 中文😀/);

  await fs.writeFile(path.join(workspace, 'gbk-output.cjs'), `const bytes = [0xd6,0xd0,0xce,0xc4,10]; const t=setInterval(()=>{process.stdout.write(Buffer.from([bytes.shift()])); if(!bytes.length) clearInterval(t);},15);`);
  assert.match(await run({ command: command('gbk-output.cjs'), encoding: 'cp936' }), /中文/);
  if (process.platform === 'win32') {
    const missing = await run({ command: 'where claude_local_missing_command_for_test' });
    assert.equal(field(missing, 'exitCode'), '1');
    assert.ok(!missing.includes('\ufffd'), 'cmd 本身的本地化输出必须能解码');
  }
  await fs.writeFile(path.join(workspace, 'process-tree.cjs'), `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('PARENT_PID='+process.pid+' CHILD_PID='+child.pid); setInterval(()=>{},1000);`);
  const first = new Client({ name: 'job-start', version: '1' });
  await first.connect(new SSEClientTransport(new URL(url)));
  await first.listTools();
  const started = text(await first.callTool({ name: 'bash', arguments: { action: 'start', command: command('process-tree.cjs') } }));
  const id = field(started, 'jobId');
  await first.close();
  const second = new Client({ name: 'job-reconnect', version: '1' });
  await second.connect(new SSEClientTransport(new URL(url)));
  const invoke = async (args) => text(await second.callTool({ name: 'bash', arguments: args }));
  try {
    assert.ok((await invoke({ action: 'list' })).includes(id));
    let status;
    const deadline = Date.now() + 5000;
    do {
      status = await invoke({ action: 'output', jobId: id });
      if (status.includes('CHILD_PID=')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.match(status, /status: running/);
    const pids = status.match(/PARENT_PID=(\d+) CHILD_PID=(\d+)/);
    assert.ok(pids, status);
    assert.match(await invoke({ action: 'stop', jobId: id }), /status: stopped/);
    gone(pids[1]); gone(pids[2]);
    assert.match(await invoke({ action: 'stop', jobId: id }), /status: stopped/, '重复停止应安全');
  } finally { await second.close(); }
  const timed = await run({ command: command('process-tree.cjs'), timeout: 1500 });
  assert.match(timed, /status: timed_out/);
  const timeoutPids = timed.match(/PARENT_PID=(\d+) CHILD_PID=(\d+)/);
  assert.ok(timeoutPids, timed);
  gone(timeoutPids[1]); gone(timeoutPids[2]);
  for (const args of [{}, { action: 'stop' }, { action: 'list', command: 'echo bad' }, { command: 'echo bad', encoding: 'unknown' }, { command: 'echo bad', timeout: 2147483648 }]) {
    assert.ok((await call('bash', args)).isError, `必须拒绝 ${JSON.stringify(args)}`);
  }

  // 服务关闭和切换 Shell 也检查真实进程；打包模式的 SSE 用例仍由打包服务执行。
  const shellPaths = process.platform === 'win32' ? ['powershell.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps', 'pwsh.exe')] : ['/bin/sh'];
  for (const shellPath of shellPaths) {
    if (path.isAbsolute(shellPath) && !await fs.lstat(shellPath).catch(() => null)) continue;
    const shell = await createShell(workspace, shellPath);
    try {
      const result = await shell.execute({ command: 'echo 中文' });
      assert.match(result, /exitCode: 0/);
      assert.match(await fs.readFile(field(result, 'stdoutPath'), 'utf8'), /中文/);
      const sleeping = await shell.execute({ action: 'start', command: 'node -e "console.log(process.pid); setInterval(()=>{},1000)"' });
      const jobId = field(sleeping, 'jobId');
      await shell.close();
      assert.match(await shell.execute({ action: 'output', jobId }), /status: stopped/);
      await assert.rejects(shell.execute({ command: 'echo bad' }), /停止/);
    } finally { await shell.close(); }
  }
}
