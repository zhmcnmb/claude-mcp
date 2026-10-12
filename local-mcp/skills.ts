import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SkillInfo = { name: string; description: string; path: string };
export type AgentsFile = { path: string; content: string };

/** Skill 来源目录，优先级从高到低（项目目录优先于全局）。 */
export function skillSources(workspace: string): string[] {
  return [
    path.join(workspace, '.pi', 'skills'),
    path.join(os.homedir(), '.pi', 'agent', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
  ];
}

/** 全局规则优先加载，再按根目录到工作区的顺序读取祖先规则全文。 */
export async function loadAgentsFiles(workspace: string): Promise<AgentsFile[]> {
  const dirs: string[] = [];
  let dir = path.resolve(workspace);
  for (;;) {
    dirs.unshift(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  dirs.unshift(path.join(os.homedir(), '.pi', 'agent'));
  const files: AgentsFile[] = [];
  const seen = new Set<string>();
  for (const source of dirs) {
    const file = path.join(source, 'AGENTS.md');
    try {
      const canonical = await fs.realpath(file);
      const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (seen.has(key)) continue;
      const content = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
      files.push({ path: file, content });
      seen.add(key);
    } catch (e: any) {
      if (e?.code === 'ENOENT') continue;
      throw new Error(`无法读取规则文件 ${file}：${e?.message ?? e}`, { cause: e });
    }
  }
  return files;
}

/** AGENTS.md 是预加载的基础规则，不依赖模型调用 read。 */
export function formatAgentsInstructions(files: AgentsFile[]): string {
  if (files.length === 0) return '';
  const body = files.map((file) => `规则文件: ${file.path}\n${file.content}`).join('\n\n');
  return `以下规则适用于当前工作区，处理任务前必须遵循。规则按全局、父级、工作区顺序排列；冲突时更具体目录的规则优先。\n<project_instructions>\n${body}\n</project_instructions>`;
}

/** 解析 SKILL.md 的 YAML frontmatter（简单 key: value 行，支持折行续写），只取 name/description。 */
function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const m = raw.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const meta: Record<string, string> = {};
  let lastKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      lastKey = kv[1];
      meta[lastKey] = kv[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    } else if (lastKey && /^\s+\S/.test(line)) {
      meta[lastKey] = `${meta[lastKey]} ${line.trim()}`;
    }
  }
  return { name: meta.name, description: meta.description };
}

/** 扫描全部来源中的 <来源>/<名称>/SKILL.md；同名时排在前面的来源优先。 */
export async function scanSkills(workspace: string): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  const skills: SkillInfo[] = [];
  for (const source of skillSources(workspace)) {
    let entries;
    try {
      entries = await fs.readdir(source, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillFile = path.join(source, entry.name, 'SKILL.md');
      let raw: string;
      try {
        raw = await fs.readFile(skillFile, 'utf8');
      } catch {
        continue;
      }
      const meta = parseFrontmatter(raw);
      const name = meta.name || entry.name;
      if (seen.has(name)) continue;
      seen.add(name);
      skills.push({ name, description: meta.description ?? '', path: skillFile });
    }
  }
  return skills;
}

/** 注入工具描述的 skills catalog（渐进披露，需要时自己 read）。 */
export function formatSkillsCatalog(skills: SkillInfo[]): string {
  const header =
    '可用的本地 skills：\n当任务匹配下面某个 skill 时，先用 read 工具读取它的 SKILL.md 并遵循其中的指示。';
  if (skills.length === 0) return `${header}\n（未发现）`;
  const lines = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}\n  路径: ${s.path}`);
  return `${header}\n${lines.join('\n')}`;
}
