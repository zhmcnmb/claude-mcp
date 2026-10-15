import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { applyEdits, decodeText, describeFormat, encodeText, preserveWriteEol } from './text-files.ts';
import { utf8Slice } from './shell.ts';
import type { Shell, ShellArgs } from './shell.ts';

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

export type ToolSession = { workspace: string; shell: Shell; reads: Map<string, string>; readVersions?: ReadonlyMap<string, string> };
export const fileKey = (file: string): string => process.platform === 'win32' ? file.toLowerCase() : file;
export const contentHash = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** 新文件也解析已有父目录的真实路径，避免符号链接别名绕过版本检查。 */
export async function resolveToolPath(workspace: string, input: string): Promise<string> {
  let candidate = path.resolve(workspace, input);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(candidate), ...missing.reverse()); }
    catch (error: any) {
      if (error.code !== 'ENOENT' || path.dirname(candidate) === candidate) throw error;
      missing.push(path.basename(candidate));
      candidate = path.dirname(candidate);
    }
  }
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: Content[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

const fileLocks = new Map<string, Promise<void>>();
async function withFileLock<T>(file: string, run: () => Promise<T>): Promise<T> {
  const key = fileKey(file);
  const previous = fileLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  fileLocks.set(key, current);
  await previous;
  try { return await run(); }
  finally { release(); if (fileLocks.get(key) === current) fileLocks.delete(key); }
}

async function readExisting(file: string): Promise<Buffer | null> {
  try { return await fs.readFile(file); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}

function checkVersion(file: string, bytes: Buffer | null, expected: string | undefined): void {
  if (bytes === null && expected === undefined) return;
  if (expected === undefined) throw new Error(`请先用 read 读取已有文件：${file}，未修改文件。`);
  if (bytes === null || contentHash(bytes) !== expected) throw new Error(`文件自上次读取后已变化，请重新 read：${file}，未修改文件。`);
}

async function saveFile(file: string, bytes: Buffer, expected: string | undefined): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const stat = await fs.stat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (stat && stat.nlink > 1) throw new Error('文件有多个硬链接，无法安全原子替换，未修改文件。');
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', stat?.mode ?? 0o666);
  try {
    try {
      if (stat) await handle.chmod(stat.mode);
      await handle.writeFile(bytes);
      await handle.sync();
    }
    finally { await handle.close(); }
    // shortcut: 外部程序仍可能在校验与替换之间写入；需要强隔离时使用独立工作副本。
    checkVersion(file, await readExisting(file), expected);
    // 已有文件原子替换；新文件用 link 发布，不能覆盖同时出现的外部文件。
    if (stat) await fs.rename(temporary, file);
    else await fs.link(temporary, file);
  } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

async function readTool(args: { path: string; offset?: number; limit?: number }, session: ToolSession): Promise<ToolResult> {
  const file = await resolveToolPath(session.workspace, args.path);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return fail(`文件不存在：${file}`);
  }
  if (stat.isDirectory()) return fail(`${file} 是目录——请用 bash 工具列出内容（如 ls）。`);
  const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
  if (mime) {
    const data = await fs.readFile(file);
    return { content: [{ type: 'image', data: data.toString('base64'), mimeType: mime }] };
  }
  let text: string;
  let hash: string;
  let format: string;
  try {
    const loaded = await withFileLock(file, async () => {
      const bytes = await fs.readFile(file);
      const decoded = decodeText(bytes);
      return { text: decoded.text, hash: contentHash(bytes), format: describeFormat(decoded) };
    });
    ({ text, hash, format } = loaded);
  } catch (e: any) {
    return fail(`无法读取 ${file}：${e?.message ?? e}`);
  }
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // 末尾换行是上一行的终止符，不算空行
  const offset = Math.max(1, Math.floor(args.offset ?? 1));
  if (offset > lines.length) return fail(`offset 超出文件范围：共 ${lines.length} 行，未更新读取版本。`);
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? MAX_LINES)), MAX_LINES);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  let out = slice.map((l, i) => `${offset + i}: ${l}`).join('\n');
  let truncated = offset - 1 + slice.length < lines.length;
  if (Buffer.byteLength(out) > MAX_BYTES) {
    out = utf8Slice(out, MAX_BYTES);
    truncated = true;
  }
  if (truncated) out += `\n[已截断 — 共 ${lines.length} 行，用 offset/limit 继续读取]`;
  session.reads.set(fileKey(file), hash);
  return ok([format, out || '（空文件）'].filter(Boolean).join('\n'));
}

async function writeTool(args: { path: string; content: string }, session: ToolSession): Promise<ToolResult> {
  const file = await resolveToolPath(session.workspace, args.path);
  const expected = (session.readVersions ?? session.reads).get(fileKey(file));
  try {
    await withFileLock(file, async () => {
      const original = await readExisting(file);
      checkVersion(file, original, expected);
      const decoded = original === null ? { text: '', encoding: 'utf8' as const, bom: Buffer.alloc(0) } : decodeText(original);
      const content = original === null ? args.content : preserveWriteEol(decoded.text, args.content);
      const bytes = encodeText(decoded, content);
      await saveFile(file, bytes, expected);
      session.reads.set(fileKey(file), contentHash(bytes));
    });
  } catch (e: any) {
    return fail(`无法写入 ${file}：${e?.message ?? e}`);
  }
  return ok(`已写入 ${file}（${args.content.length} 字符）`);
}

async function editTool(args: {
  path: string;
  oldText?: string;
  newText?: string;
  edits?: { oldText: string; newText: string }[];
  replaceAll?: boolean;
}, session: ToolSession): Promise<ToolResult> {
  const file = await resolveToolPath(session.workspace, args.path);
  const expected = (session.readVersions ?? session.reads).get(fileKey(file));
  const edits = args.edits ?? [{ oldText: args.oldText!, newText: args.newText! }];
  let changed!: ReturnType<typeof applyEdits>;
  try {
    await withFileLock(file, async () => {
      const original = await readExisting(file);
      if (original === null) throw new Error(`文件不存在：${file}`);
      checkVersion(file, original, expected);
      const decoded = decodeText(original);
      changed = applyEdits(decoded.text, edits, args.replaceAll);
      const bytes = encodeText(decoded, changed.text);
      await saveFile(file, bytes, expected);
      session.reads.set(fileKey(file), contentHash(bytes));
    });
  } catch (e: any) {
    return fail(`无法写入 ${file}：${e?.message ?? e}`);
  }
  return ok(`已编辑 ${file}（${changed.count} 处）\n第一处改动附近：\n${changed.preview}`);
}

async function bashTool(args: ShellArgs, session: ToolSession): Promise<ToolResult> {
  return ok(await session.shell.execute(args));
}

export const toolDefs = [
  {
    name: 'read',
    description:
      '读取文件并记录本连接的文件版本。文本支持 UTF-8、带 BOM 的 UTF-16、可无损往返的 GBK；非 UTF-8/LF 时首行标注文件格式；返回带行号的输出，2000 行 / 50KB 截断，用 offset/limit 继续读取。图片返回图像内容。相对路径相对于工作区解析。若结果附带目录规则，先遵循规则，再用返回的 contextVersion 调用 write/edit/bash。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '文件路径，相对于工作区或绝对路径' },
        offset: { type: 'integer', minimum: 1, description: '起始行，从 1 开始（默认 1）' },
        limit: { type: 'integer', minimum: 1, description: '最多读取行数（默认 2000）' },
      },
      required: ['path'],
    },
    handler: readTool,
  },
  {
    name: 'write',
    description: '创建文件或整体覆盖。覆盖已有文件前必须用本连接的 read 读取；版本变化则拒绝写入。保留原编码、BOM 和统一行尾；混合行尾请用 edit。遇到 CONTEXT_REQUIRED 时先遵循返回的规则，再带 contextVersion 重试。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '文件路径，相对于工作区或绝对路径' },
        content: { type: 'string', description: '完整文件内容' },
        contextVersion: { type: 'string', description: '目录规则返回的版本；规则更新后使用新版' },
      },
      required: ['path', 'content'],
    },
    handler: writeTool,
  },
  {
    name: 'edit',
    description:
      '先用本连接的 read 读取，再精确替换。支持 LF/CRLF 匹配，保留编码、BOM 及未修改部分的行尾。单处传 oldText/newText，多处传 edits。默认每个 oldText 必须唯一匹配；replaceAll=true 可替换所有非重叠匹配，区域不得重叠；版本变化或任一编辑失败则全部不写入。遇到 CONTEXT_REQUIRED 时先遵循规则，再带 contextVersion 重试。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '文件路径，相对于工作区或绝对路径' },
        oldText: { type: 'string', minLength: 1, description: '要替换的原文本；默认必须恰好出现一次' },
        replaceAll: { type: 'boolean', description: '替换每个 oldText 的所有匹配，默认 false；重叠仍拒绝' },
        newText: { type: 'string', description: '替换后的文本' },
        contextVersion: { type: 'string', description: '目录规则返回的版本；规则更新后使用新版' },
        edits: {
          type: 'array',
          minItems: 1,
          description: 'oldText/newText 的批量形式：多个编辑针对原文件原子生效',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              oldText: { type: 'string', minLength: 1 },
              newText: { type: 'string' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path'],
    },
    handler: editTool,
  },
  {
    name: 'bash',
    description:
      '执行 shell 命令。action 默认 run 等待结束（默认超时 120 秒）；长任务用 start 立即返回 jobId，默认无超时。用 list 列任务、output 获取状态和输出尾部、stop 结束进程树。任务跨网页重连保留，停止本地服务时终止。返回输出与末行 exitCode，stderr 单独标注；超过 2000 行 / 50KB 时只返回末尾，完整输出写入 UTF-8 日志并给出路径，可用 read 分段读取。cwd 默认工作区，cd 不跨调用保持；操作其他项目须传 cwd 以加载规则。优先用 rg 搜索，支持 rtk。默认输出 UTF-8，旧程序可显式指定 encoding。遇到 CONTEXT_REQUIRED 时先遵循规则，再带 contextVersion 重试。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['run', 'start', 'list', 'output', 'stop'], description: '默认 run；start 后用 output/stop 管理后台任务' },
        command: { type: 'string', description: 'run/start 必填；其他操作不传' },
        jobId: { type: 'string', description: 'output/stop 必填；用 list 可找回任务' },
        cwd: { type: 'string', description: 'run/start 的工作目录，默认工作区' },
        encoding: { type: 'string', enum: ['utf8', 'cp936', 'utf16le'], description: '命令输出编码，默认 utf8；cp936 适用于固定 GBK 输出的旧程序' },
        contextVersion: { type: 'string', description: '目录规则返回的版本；规则更新后使用新版' },
        timeout: { type: 'integer', minimum: 1, maximum: 2147483647, description: '超时毫秒数；run 默认 120000，start 默认无超时' },
      },
      required: [],
    },
    handler: bashTool,
  },
];

/** MCP 的 CallToolRequest 只验证协议信封，具体参数仍须在执行前验证。 */
export function validateToolArgs(name: string, input: unknown): string | undefined {
  const def = toolDefs.find((tool) => tool.name === name);
  if (!def) return `未知工具：${name}`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '工具参数必须是对象。';
  const args = input as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(def.inputSchema.properties, key)) return `未知参数：${key}`;
  }
  const string = (key: string, nonempty = false) => typeof args[key] === 'string' && (!nonempty || (args[key] as string).trim().length > 0);
  for (const key of def.inputSchema.required) if (!string(key, key !== 'content')) return `${key} 必须是${key === 'content' ? '' : '非空'}字符串。`;
  for (const key of ['path', 'cwd', 'command']) {
    if (args[key] !== undefined && (!string(key, true) || (args[key] as string).includes('\0'))) return `${key} 必须是非空且不含 NUL 的字符串。`;
  }
  if (args.contextVersion !== undefined && !string('contextVersion', true)) return 'contextVersion 必须是非空字符串。';
  for (const key of ['offset', 'limit', 'timeout']) {
    if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || (args[key] as number) < 1)) return `${key} 必须是正整数。`;
  }
  if (name === 'bash') {
    const action = args.action ?? 'run';
    if (!['run', 'start', 'list', 'output', 'stop'].includes(action as string)) return '无效 action。';
    if (action === 'run' || action === 'start') {
      if (!string('command', true)) return 'command 必须是非空字符串。';
      if (args.jobId !== undefined) return 'run/start 不接受 jobId。';
      if (args.timeout !== undefined && (args.timeout as number) > 2147483647) return 'timeout 不能超过 2147483647 毫秒。';
      if (args.encoding !== undefined && !['utf8', 'cp936', 'utf16le'].includes(args.encoding as string)) return 'encoding 必须是 utf8、cp936 或 utf16le。';
    } else {
      if (['command', 'cwd', 'timeout', 'encoding'].some((key) => args[key] !== undefined)) return '任务管理操作不接受 command/cwd/timeout/encoding。';
      if (action !== 'list' && !string('jobId', true)) return 'output/stop 必须提供 jobId。';
      if (action === 'list' && args.jobId !== undefined) return 'list 不接受 jobId。';
    }
  }
  if (args.replaceAll !== undefined && typeof args.replaceAll !== 'boolean') return 'replaceAll 必须是布尔值。';
  if (name === 'edit') {
    if (args.edits !== undefined && (args.oldText !== undefined || args.newText !== undefined)) return 'edits 与 oldText/newText 不能同时提供。';
    const edits = args.edits ?? [{ oldText: args.oldText, newText: args.newText }];
    if (!Array.isArray(edits) || edits.length === 0) return 'edits 必须是非空数组。';
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit) || typeof edit.oldText !== 'string' || !edit.oldText.length || typeof edit.newText !== 'string') return '每处编辑必须提供非空 oldText 和字符串 newText；删除时 newText 传空字符串。';
      if (Object.keys(edit).some((key) => key !== 'oldText' && key !== 'newText')) return '编辑项只能包含 oldText/newText。';
    }
  }
}
