# Claude.ai 的 MCP 支持

一个浏览器扩展，让 Claude.ai 直接使用 MCP（Model Context Protocol）能力，把 Claude 连接到外部工具和服务。启用的是 claude.ai 本身已存在但未开放的功能。

<img width="400" alt="Screenshot 2025-04-12 at 3 53 10 PM" src="https://github.com/user-attachments/assets/65e69843-58d4-4686-80d9-1f6bb000e015" />
<img width="400" alt="Screenshot 2025-04-12 at 3 53 33 PM" src="https://github.com/user-attachments/assets/ba4b9b62-1cae-41db-ad58-8a824b6f861a" />

## 功能特性

- 将 Claude.ai 连接到兼容 MCP 的服务器
- 管理多个服务器连接
- 配置环境变量和命令行参数
- 调试日志选项
- 深色模式支持

## 安装

### 从源码安装

1. 克隆本仓库
```bash
git clone https://github.com/zhmcnmb/claude-mcp.git
cd claude-mcp
```

2. 安装依赖
```bash
npm install
# 或
pnpm install
```

3. 构建扩展
```bash
npm run build
# 或
pnpm build
```

4. 在浏览器中加载扩展：

**Chrome/Edge**：
- 打开 `chrome://extensions/`
- 开启“开发者模式”
- 点击“加载已解压的扩展程序”
- 选择本仓库的 `dist` 目录

**Firefox**：
- 打开 `about:debugging#/runtime/this-firefox`
- 点击“临时载入附加组件”
- 选择 `dist` 目录中的 `manifest.json`

## 使用方法

1. 在 claude.ai 页面点击浏览器工具栏上的扩展图标
2. 添加新的 MCP 服务器连接，填写：
   - Name：便于识别的名称
   - URL：MCP 服务器的端点地址
   - Command（可选）：在服务器上执行的命令
   - Arguments（可选）：命令行参数
   - Environment Variables（可选）：键值对形式的环境变量

3. 配置完成后，访问 Claude.ai 时扩展会自动连接已配置的服务器
4. Claude 即可在对话中使用这些服务器提供的工具

## 开发

以热重载方式运行开发模式：
```bash
npm run dev
# 或
pnpm dev
```

## 技术细节

扩展通过 SSE（Server-Sent Events）与 MCP 服务器通信，由以下部分组成：

- 管理存储和扩展状态的后台脚本
- 向 Claude.ai 注入 MCP 能力的内容脚本
- 在上下文之间安全通信的隔离内容脚本
- 管理服务器连接的弹窗 UI

## 本地编码 MCP（`local-mcp/`）

`local-mcp/` 提供 `claude-local`：一个给 Claude.ai 用的极简本地编码服务，工具层照搬 [pi](https://github.com/badlogic/pi-mono) 的设计——只有 `read`、`write`、`edit`、`bash` 四个工具，外加 Pi 风格的 skills 发现。不提供 `list_directory`/`git_status`/`search_files` 之类的工具：这些模型都通过 `bash` 自己完成。

```bash
cd local-mcp
npm install
node server.ts <工作区目录> [--port 8765] [--host 127.0.0.1]
```

然后在扩展弹窗里把打印出的 URL（`http://127.0.0.1:8765/sse`）添加为服务器。服务只绑定回环地址，使用扩展实际支持的 legacy SSE 传输（`/sse` + `/messages`，已处理 CORS 与 Private Network Access 预检）。

**工具**

- `read(path, offset?, limit?)` — 带行号输出（`1: ...`），2000 行 / 50KB 截断；图片（png/jpg/gif/webp/bmp）返回为可查看的图像内容
- `write(path, content)` — 创建（自动建父目录）或整体覆盖
- `edit(path, oldText, newText)` 或 `edit(path, edits: [...])` — 精确字符串替换；每个 `oldText` 必须在原文件中唯一匹配，批量编辑对原文件原子生效（任一失败全部不落盘）
- `bash(command, timeout?)` — 在工作区内执行，返回 `exitCode`/`stdout`/`stderr`（保留尾部，超限截断）。Windows 下默认走 `cmd.exe`，设置环境变量 `CLAUDE_LOCAL_SHELL` 可换其他 shell

**Skills**

服务启动时扫描以下目录中的 `<名称>/SKILL.md`（同名时项目目录优先于全局），只把每个 skill 的 `name`/`description`/`path` 注入工具描述。任务匹配某个 skill 时，Claude 用 `read` 工具读取完整 `SKILL.md` 再执行——渐进披露，不需要单独的 skill 运行时：

1. `<工作区>/.pi/skills`
2. `~/.pi/agent/skills`
3. `~/.agents/skills`

如果 `<工作区>/AGENTS.md` 存在，catalog 也会指引 Claude 先读并遵循它——同样是渐进披露，文件内容不内联。

每次 `tools/list` 都会重新扫描 skills，服务运行期间新增的 skill 无需重启即可生效（catalog 变化时发送 `tools/list_changed` 通知）。

运行端到端自检（启动服务，驱动 SSE 握手并调用全部四个工具）：

```bash
node test.mjs
```

要求 Node >= 22.18（直接以类型擦除方式运行 TypeScript 源码）。

## 许可证

[MIT](LICENSE)
