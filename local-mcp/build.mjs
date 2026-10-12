import './bundle.mjs';
import { build, Platform, Arch } from 'electron-builder';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, '../outputs/claude-local');
const targets = process.argv.slice(2);
if (!targets.length) targets.push(process.platform === 'win32' ? 'win-x64' : 'macos-arm64');
for (const target of targets) {
  if (!['win-x64', 'macos-arm64'].includes(target)) throw new Error(`不支持的目标：${target}`);
  if (target.startsWith('macos-') && process.platform !== 'darwin') throw new Error('macOS 应用必须在 Mac 上构建和签名。可使用仓库的 Build desktop apps 工作流。');
}
const buildTargets = new Map();
for (const target of targets) {
  const platform = target.startsWith('macos-') ? Platform.MAC : Platform.WINDOWS;
  const arch = target.endsWith('arm64') ? Arch.arm64 : Arch.x64;
  for (const [key, value] of platform.createTarget(target.startsWith('macos-') ? 'dmg' : 'portable', arch)) {
    if (!buildTargets.has(key)) buildTargets.set(key, new Map());
    for (const [targetArch, formats] of value) buildTargets.get(key).set(targetArch, formats);
  }
}
await build({
  targets: buildTargets,
  projectDir: here,
  config: {
    appId: 'local.claude.mcp', productName: 'Claude Local MCP',
    directories: { output },
    electronDist: process.platform === 'win32' ? path.join(here, 'node_modules/electron/dist') : undefined,
    files: ['desktop/**', 'dist/**', 'package.json'],
    asar: true,
    icon: path.join(here, 'desktop/icon.png'),
    win: { signExecutable: false, artifactName: 'Claude-Local-MCP-windows-${arch}.${ext}' },
    mac: { identity: '-', artifactName: 'Claude-Local-MCP-macos-${arch}.${ext}', category: 'public.app-category.developer-tools' },
  },
});
