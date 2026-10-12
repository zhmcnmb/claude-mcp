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
- 选择本仓库的 `dist-chrome` 目录

**Firefox**：
- 打开 `about:debugging#/runtime/this-firefox`
- 点击“临时载入附加组件”
- 先运行 `npm run build:firefox`，再选择 `dist-firefox` 目录中的 `manifest.json`

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

当前网页聊天使用 RPC 协议，扩展在 Claude 页面内提供 MCP 客户端标识和 `claudeAppBindings` 连接接口，让本地工具进入对话请求，并在切换对话时重新建立连接。这会让 Claude 页面采用桌面客户端界面；Ads 浏览器配置及其他网站的 User-Agent 不变。该兼容方式依赖 Claude 的内部接口，网页更新后可能需要再次适配，不能据此认为浏览器具备完整的原生桌面功能。

更新源码后运行 `npm run build:chrome`，在 `chrome://extensions/` 重新加载扩展，再刷新 Claude 页面。验证时在新消息中要求本地 `bash` 执行 `printf MCP_CONNECTION_OK`，检查是否出现对应服务器的工具调用记录；仅连接成功或菜单出现服务器不足以确认模型能调用工具。

## 开发

连接重建和客户端兼容性回归检查：
```bash
node --test tests/content.test.mjs
```

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

### 桌面图形界面（无需安装 Node）

- **Windows x64**：双击 `Claude-Local-MCP-windows-x64.exe`，打开桌面窗口。
- **macOS Apple Silicon（M 系列）**：打开 `Claude-Local-MCP-macos-arm64.dmg`，将应用拖入“应用程序”，双击启动。
- 在窗口中选择工作区，直接修改完整 **服务 URL**（主机、端口和路径），点击 **启动服务**。例如 `http://127.0.0.1:9000/custom-mcp`。
- 点击 **复制 URL**，粘贴到浏览器扩展的 URL 字段。修改地址后，需要同步更新扩展。
- 点击 **停止服务** 后即可修改设置；启动成功会自动保存。运行状态、端口冲突和工具日志直接显示在窗口内。
- 点击窗口关闭按钮后，可选 **隐藏到托盘** 或 **退出程序**，也可取消。隐藏后服务继续运行；Windows 使用右下角托盘，macOS 使用顶部菜单栏图标。右击图标可 **显示窗口** 或 **退出程序**；Windows 双击托盘图标也能恢复窗口。退出会停止服务并释放端口。

桌面界面仅允许本机回环地址（`127.0.0.1`、`localhost`、`[::1]`），不需要认证即可执行的文件与命令工具不向局域网开放。设置保存在系统应用数据目录的 `claude-local/settings.json`，首次使用会读取旧版 `~/.claude-local/workspace.json` 中的工作区，无需手动删除配置。

程序、窗口和托盘统一使用浏览器扩展的标志。

程序内置服务运行时；`bash` 调用的 Git、Python、Node 等开发工具仍使用电脑上安装的版本。Windows 产物未做发行证书签名，macOS 使用 ad-hoc 签名，未做 Apple 开发者签名/公证。

开发者构建及验证（用户日常使用无需运行命令）：

```bash
cd local-mcp
npm ci
npm run desktop        # 启动开发界面
npm run test:desktop   # 实际窗口操作自检
npm run build:windows  # Windows 便携版
npm run build:mac      # 在 Mac 上构建 Apple Silicon DMG
```

产物位于 `outputs/claude-local/`。也可在 GitHub Actions 手动运行 **Build desktop apps**，下载对应系统的构建产物。macOS 必须在 Mac 上构建、签名和验证。

**在 Mac 上构建**：先安装 Node.js >= 22.18 和 Xcode Command Line Tools（未安装时运行 `xcode-select --install`），再将当前项目完整复制到 Mac。在项目根目录运行：

```bash
cd local-mcp
npm ci
npm run test:desktop
npm run build:mac
```

这会生成 `outputs/claude-local/Claude-Local-MCP-macos-arm64.dmg`，仅支持 Apple Silicon（M 系列）。构建使用本机 ad-hoc 签名；若需要面向其他用户发行，仍需 Apple Developer ID 签名及公证。

### 从源码启动

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

**AGENTS.md 基础规则**

服务启动时自动读取 `~/.pi/agent/AGENTS.md`，再按文件系统根目录到工作区的顺序读取各级 `AGENTS.md`，相同文件只加载一次。全文以 `<project_instructions>` 放入 MCP `initialize.instructions`，作为当前工作区的基础规则；发生冲突时，更具体目录的规则优先。规则与 skills 的按需加载分开，不再要求模型先调用 `read` 才获得规则，也不在四个工具描述中重复规则全文。规则文件不存在时跳过；存在但无法读取时启动失败，避免静默漏掉规则。

修改 `AGENTS.md` 后需要重启服务并让网页重新连接。MCP 客户端是否将 `initialize.instructions` 交给模型取决于客户端实现；服务端已发送全文仍需在 Claude 网页验证实际生效。

每次 `tools/list` 都会重新扫描 skills，服务运行期间新增的 skill 无需重启即可生效（catalog 变化时发送 `tools/list_changed` 通知）。

运行端到端自检（启动服务，驱动 SSE 握手并调用全部四个工具）：

```bash
node test.mjs
```

要求 Node >= 22.18（直接以类型擦除方式运行 TypeScript 源码）。

## 许可证

[MIT](LICENSE)
