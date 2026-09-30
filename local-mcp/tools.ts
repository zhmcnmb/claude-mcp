import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

let workspace = process.cwd();

export function setWorkspace(dir: string): void {
  workspace = path.resolve(dir);
}

export function getWorkspace(): string {
  return workspace;
}

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(workspace, p);
}

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** 与 Pi 一致：输出超限时保留尾部（最后 MAX_LINES 行 / MAX_BYTES 字节）。 */
function truncateTail(s: string): string {
  let t = s;
  let cut = false;
  if (Buffer.byteLength(t) > MAX_BYTES) {
    const buf = Buffer.from(t, 'utf8');
    t = buf.subarray(buf.length - MAX_BYTES).toString('utf8');
    cut = true;
  }
  const lines = t.split('\n');
  if (lines.length > MAX_LINES) {
    t = lines.slice(-MAX_LINES).join('\n');
    cut = true;
  }
  return cut ? `[已截断 — 仅显示最后 ${MAX_LINES} 行 / ${MAX_BYTES / 1024}KB]\n${t}` : t;
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

async function readTool(args: { path: string; offset?: number; limit?: number }): Promise<ToolResult> {
  const file = resolvePath(args.path);
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
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e: any) {
    return fail(`无法读取 ${file}：${e?.message ?? e}`);
  }
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // 末尾换行是上一行的终止符，不算空行
  const offset = Math.max(1, Math.floor(args.offset ?? 1));
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? MAX_LINES)), MAX_LINES);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  let out = slice.map((l, i) => `${offset + i}: ${l}`).join('\n');
  let truncated = offset - 1 + slice.length < lines.length;
  if (Buffer.byteLength(out) > MAX_BYTES) {
    out = Buffer.from(out, 'utf8').subarray(0, MAX_BYTES).toString('utf8');
    truncated = true;
  }
  if (truncated) out += `\n[已截断 — 共 ${lines.length} 行，用 offset/limit 继续读取]`;
  return ok(out || '（空文件）');
}

async function writeTool(args: { path: string; content: string }): Promise<ToolResult> {
  const file = resolvePath(args.path);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, args.content ?? '', 'utf8');
  } catch (e: any) {
    return fail(`无法写入 ${file}：${e?.message ?? e}`);
  }
  return ok(`已写入 ${file}（${(args.content ?? '').length} 字符）`);
}

async function editTool(args: {
  path: string;
  oldText?: string;
  newText?: string;
  edits?: { oldText: string; newText: string }[];
}): Promise<ToolResult> {
  const file = resolvePath(args.path);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return fail(`文件不存在：${file}`);
  }
  const edits = args.edits ?? (args.oldText !== undefined ? [{ oldText: args.oldText, newText: args.newText ?? '' }] : null);
  if (!edits || edits.length === 0) return fail('请提供 oldText/newText 或非空 edits 数组。');
  // 所有编辑都针对原文件匹配；任何一个失败则整个调用不写入。
  const matches: { start: number; end: number; newText: string }[] = [];
  for (let i = 0; i < edits.length; i++) {
    const label = args.edits ? `edits[${i}].oldText` : 'oldText';
    const { oldText, newText } = edits[i];
    if (!oldText) return fail(`${label} 必须是非空字符串。`);
    const count = text.split(oldText).length - 1;
    if (count === 0) return fail(`${label} 在 ${file} 中未找到匹配，未做任何修改。`);
    if (count > 1) return fail(`${label} 在 ${file} 中匹配到 ${count} 处，必须唯一匹配，未做任何修改。`);
    const start = text.indexOf(oldText);
    matches.push({ start, end: start + oldText.length, newText: newText ?? '' });
  }
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) return fail('edits 发生重叠：每个编辑必须针对不同区域，未做任何修改。');
  }
  let out = text;
  for (const m of sorted.reverse()) out = out.slice(0, m.start) + m.newText + out.slice(m.end);
  try {
    await fs.writeFile(file, out, 'utf8');
  } catch (e: any) {
    return fail(`无法写入 ${file}：${e?.message ?? e}`);
  }
  return ok(`已编辑 ${file}（${edits.length} 处）`);
}

function bashTool(args: { command: string; timeout?: number }): Promise<ToolResult> {
  return new Promise((resolve) => {
    exec(
      args.command,
      {
        cwd: workspace,
        shell: process.env.CLAUDE_LOCAL_SHELL || undefined,
        timeout: Math.min(Math.max(1, args.timeout ?? 120_000), 600_000),
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        let err = stderr ?? '';
        if (error?.killed) err += `\n[已被终止：执行超时]`;
        resolve(ok(`exitCode: ${exitCode}\n\nstdout:\n${truncateTail(stdout ?? '')}\n\nstderr:\n${truncateTail(err)}`));
      },
    );
  });
}

export const toolDefs = [
  {
    name: 'read',
    description:
      '读取文件。文本返回带行号的输出（"行号: 内容"），2000 行 / 50KB 截断——用 offset/limit 继续读取。图片（png/jpg/jpeg/gif/webp/bmp）返回为可查看的图像内容。相对路径相对于工作区解析。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对于工作区或绝对路径' },
        offset: { type: 'number', description: '起始行，从 1 开始（默认 1）' },
        limit: { type: 'number', description: '最多读取行数（默认 2000）' },
      },
      required: ['path'],
    },
    handler: readTool,
  },
  {
    name: 'write',
    description: '创建文件（自动创建父目录）或整体覆盖。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对于工作区或绝对路径' },
        content: { type: 'string', description: '完整文件内容' },
      },
      required: ['path', 'content'],
    },
    handler: writeTool,
  },
  {
    name: 'edit',
    description:
      '精确替换文件中的文本。单处修改传 oldText/newText，多处修改传 edits: [{oldText, newText}, ...]。每个 oldText 必须在原文件中唯一匹配，编辑区域不得重叠；任一编辑失败则全部不写入。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对于工作区或绝对路径' },
        oldText: { type: 'string', description: '要替换的原文本；必须在文件中恰好出现一次' },
        newText: { type: 'string', description: '替换后的文本' },
        edits: {
          type: 'array',
          description: 'oldText/newText 的批量形式：多个编辑针对原文件原子生效',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
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
      '在工作区执行 shell 命令，返回 exitCode/stdout/stderr（尾部截断到 2000 行 / 50KB）。列目录、查找、搜索、git、构建、测试都用它。Windows 下默认 cmd.exe；在服务端设置 CLAUDE_LOCAL_SHELL 环境变量可换 bash 等其他 shell。默认超时 120 秒，最长 600 秒。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number', description: '超时毫秒数（默认 120000，最长 600000）' },
      },
      required: ['command'],
    },
    handler: bashTool,
  },
];
