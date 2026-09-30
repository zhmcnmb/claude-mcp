import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SkillInfo = { name: string; description: string; path: string };

/** Skill 来源目录，优先级从高到低（项目目录优先于全局）。 */
export function skillSources(workspace: string): string[] {
  return [
    path.join(workspace, '.pi', 'skills'),
    path.join(os.homedir(), '.pi', 'agent', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
  ];
}

/** 工作区中的项目规则文件（Pi 风格 AGENTS.md），不存在则返回 null。 */
export async function findAgentsFile(workspace: string): Promise<string | null> {
  const file = path.join(workspace, 'AGENTS.md');
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
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

/** 注入工具描述的 catalog：让模型知道有哪些 skill / 项目规则（渐进披露，需要时自己 read）。 */
export function formatSkillsCatalog(skills: SkillInfo[], agentsFile: string | null = null): string {
  const skillsHeader =
    '可用的本地 skills：\n当任务匹配下面某个 skill 时，先用 read 工具读取它的 SKILL.md 并遵循其中的指示。';
  const header = agentsFile
    ? `项目规则文件: ${agentsFile}\n该文件定义了本项目的规则，开始任何工作前先用 read 工具阅读并遵循。\n\n${skillsHeader}`
    : skillsHeader;
  if (skills.length === 0) return `${header}\n（未发现）`;
  const lines = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}\n  路径: ${s.path}`);
  return `${header}\n${lines.join('\n')}`;
}
