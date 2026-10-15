import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { homedir } from 'node:os';
import iconv from 'iconv-lite';

export type ShellArgs = { action?: 'run' | 'start' | 'list' | 'output' | 'stop'; command?: string; cwd?: string; timeout?: number; jobId?: string; encoding?: string };
type Job = {
  id: string; cwd: string; pid?: number; state: string; exitCode: number | null; error?: string;
  stdout: string; stderr: string; stdoutPath: string; stderrPath: string; encoding: string;
  done: Promise<void>; stop?: Promise<void>; timer?: ReturnType<typeof setTimeout>;
};
const TAIL_BYTES = 50 * 1024;
export function utf8Slice(text: string, maxBytes: number, tail = false): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let start = tail ? bytes.length - maxBytes : 0;
  let end = tail ? bytes.length : maxBytes;
  if (tail) { while ((bytes[start] & 0xc0) === 0x80) start++; }
  else { while ((bytes[end] & 0xc0) === 0x80) end--; }
  return bytes.subarray(start, end).toString('utf8');
}
function tail(text: string): string { return utf8Slice(text, TAIL_BYTES, true).split('\n').slice(-2000).join('\n'); }

async function executable(name: string): Promise<string> {
  const candidates = path.isAbsolute(name) ? [name] : (process.env.PATH ?? '').split(path.delimiter)
    .flatMap((dir) => (process.platform === 'win32' && !path.extname(name) ? ['.exe', '.com'] : ['']).map((ext) => path.join(dir.replace(/^"|"$/g, ''), name + ext)));
  for (const file of candidates) {
    try { if ((await fs.stat(file)).isFile()) return await fs.realpath(file); }
    catch {
      // WindowsApps 的执行别名可启动，但 stat/realpath 可能返回 EACCES，必须保留别名路径。
      const aliases = path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps');
      if (process.platform === 'win32' && path.dirname(path.resolve(file)).toLowerCase() === aliases.toLowerCase()
        && path.extname(file).toLowerCase() === '.exe' && (await fs.lstat(file).catch(() => null))?.isSymbolicLink()) return path.resolve(file);
    }
  }
  throw new Error(`找不到可执行文件：${name}，请填写完整路径。`);
}

export async function createShell(workspace: string, shellPath?: string, rgPath?: string) {
  const shell = await executable(shellPath || process.env.CLAUDE_LOCAL_SHELL || (process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'));
  const name = path.basename(shell).toLowerCase();
  const kind = /^(pwsh|powershell)(\.exe)?$/.test(name) ? 'powershell' : /^cmd(\.exe)?$/.test(name) ? 'cmd' : /^(bash|sh|zsh)(\.exe)?$/.test(name) ? 'sh' : undefined;
  if (!kind) throw new Error('Shell 仅支持 cmd、PowerShell、bash、sh 或 zsh。');
  if (process.platform === 'win32' && /[\\/]windows[\\/]system32[\\/]bash\.exe$/i.test(shell)) throw new Error('此 bash 是 WSL 入口；请指定 Git Bash，例如 C:\\Program Files\\Git\\bin\\bash.exe。');
  let rg: string | undefined;
  if (rgPath) rg = await executable(rgPath);
  else {
    for (const candidate of ['rg', path.join(homedir(), '.claude-local', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')]) {
      try { rg = await executable(candidate); break; } catch { /* 未安装时在界面和工具描述中说明。 */ }
    }
  }
  const environment = `Shell: ${shell} (${kind})\nripgrep: ${rg ?? '未找到；可在桌面设置 rg 完整路径'}\n命令默认 UTF-8 输出；旧程序可指定 encoding=cp936 或 utf16le。`;
  const logRoot = path.join(workspace, 'temp', 'claude-local-jobs', randomUUID());
  const jobs = new Map<string, Job>();
  let closing = false;
  function get(id?: string): Job {
    const job = id && jobs.get(id);
    if (!job) throw new Error(`未知 jobId：${id ?? ''}；用 action=list 查看当前服务的任务。`);
    return job;
  }
  async function stop(job: Job, reason: string): Promise<void> {
    if (job.stop) return job.stop;
    if (job.state !== 'running') return job.done;
    job.stop = (async () => {
      if (job.pid) {
        if (process.platform === 'win32') {
          await new Promise<void>((resolve, reject) => {
            const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(job.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.once('error', reject);
            killer.once('close', (code) => code === 0 || job.state !== 'running' ? resolve() : reject(new Error(`taskkill 失败（${code}），请检查 PID ${job.pid}`)));
          });
        } else {
          try { process.kill(-job.pid, 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
        }
      }
      await job.done;
      job.state = reason;
    })();
    try { await job.stop; } catch (error) { job.stop = undefined; throw error; }
  }
  function report(job: Job): string {
    return `jobId: ${job.id}\nstatus: ${job.state}\nexitCode: ${job.exitCode ?? 'null'}\ncwd: ${job.cwd}\nencoding: ${job.encoding}${job.error ? `\nerror: ${job.error}` : ''}\n完整 UTF-8 日志（保留到手动清理，可用 read 分段读取）：\nstdoutPath: ${job.stdoutPath}\nstderrPath: ${job.stderrPath}\n\nstdout（最近 2000 行 / 50KB）:\n${job.stdout}\n\nstderr（最近 2000 行 / 50KB）:\n${job.stderr}`;
  }
  return {
    environment,
    async execute(args: ShellArgs): Promise<string> {
      const action = args.action ?? 'run';
      if (action === 'list') return [...jobs.values()].map((j) => `jobId: ${j.id} | ${j.state} | exitCode: ${j.exitCode} | cwd: ${j.cwd}`).join('\n') || '当前服务没有任务。';
      if (action === 'output' || action === 'stop') {
        const job = get(args.jobId);
        if (action === 'stop') await stop(job, 'stopped');
        return report(job);
      }
      if (closing) throw new Error('服务正在停止，不能启动命令。');
      const cwd = await fs.realpath(path.resolve(workspace, args.cwd ?? '.'));
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error(`cwd 不是目录：${cwd}`);
      await fs.mkdir(logRoot, { recursive: true });
      if (closing) throw new Error('服务正在停止，不能启动命令。');
      if ([...jobs.values()].filter((j) => j.state === 'running').length >= 32) throw new Error('正在运行的任务已达 32 个，请先停止或等待任务完成。');
      // shortcut: 历史任务仅保留最近 200 条；日志持久保留，大规模使用时再增加索引与清理策略。
      for (const [id, job] of jobs) { if (jobs.size < 200) break; if (job.state !== 'running') jobs.delete(id); }
      const id = randomUUID();
      const encoding = args.encoding ?? 'utf8';
      const job: Job = { id, cwd, state: 'running', exitCode: null, stdout: '', stderr: '', encoding, stdoutPath: path.join(logRoot, `${id}.stdout.log`), stderrPath: path.join(logRoot, `${id}.stderr.log`), done: Promise.resolve() };
      const command = args.command!;
      const utf8 = encoding === 'utf8';
      const shellArgs = kind === 'cmd' ? ['/d', '/s', '/c', `"${utf8 ? 'chcp 65001 >nul & ' : ''}${command}"`]
        : kind === 'powershell' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${utf8 ? '[Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' : ''}${command}`]
        : ['-c', command];
      const env = { ...process.env, ...(utf8 ? { PYTHONIOENCODING: 'utf-8' } : {}) };
      // Windows 的环境变量名不区分大小写，但展开后的 JS 对象会同时保留 Path/PATH。
      if (rg) {
        for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
        env.PATH = path.dirname(rg) + path.delimiter + (process.env.PATH ?? '');
      }
      const child = spawn(shell, shellArgs, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', windowsVerbatimArguments: kind === 'cmd', stdio: ['ignore', 'pipe', 'pipe'] });
      job.pid = child.pid;
      jobs.set(id, job);
      const completion = new Promise<void>((resolve) => {
        child.once('error', (error) => { job.error = error.message; });
        child.once('close', (code) => { job.exitCode = code; resolve(); });
      });
      const capture = (stream: NodeJS.ReadableStream, key: 'stdout' | 'stderr') => pipeline(
        stream,
        iconv.decodeStream(encoding),
        new Transform({ transform(chunk, _encoding, callback) { const text = chunk.toString('utf8'); job[key] = tail(job[key] + text); callback(null, chunk); } }),
        createWriteStream(key === 'stdout' ? job.stdoutPath : job.stderrPath, { flags: 'wx' }),
      ).catch(async (error) => {
        job.error = `日志写入失败：${error.message}`;
        // 不等待 job.done，避免与下面的日志 flush 形成环形等待。
        void stop(job, 'failed').catch((error) => { job.error += `；${error.message}`; });
      });
      job.done = Promise.all([completion, capture(child.stdout, 'stdout'), capture(child.stderr, 'stderr')]).then(() => {
        clearTimeout(job.timer);
        job.state = job.error ? 'failed' : 'exited';
      });
      const timeout = args.timeout ?? (action === 'run' ? 120000 : undefined);
      if (timeout) job.timer = setTimeout(() => { void stop(job, 'timed_out').catch((error) => { job.error = error.message; }); }, timeout);
      if (action === 'run') { await job.done; if (job.stop) await job.stop; }
      return report(job);
    },
    async close() {
      closing = true;
      await Promise.all([...jobs.values()].map((job) => stop(job, 'stopped')));
    },
  };
}

export type Shell = Awaited<ReturnType<typeof createShell>>;
