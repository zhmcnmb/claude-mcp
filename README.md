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
- 点击 **复制 URL**，粘贴到浏览器扩展的 URL 字段。修改地址后，同步修改扩展中的 URL。只更新本地 MCP 程序无需更新浏览器插件；启动新版后刷新 Claude 页面并重新连接即可。
- Shell 和 ripgrep 可直接在窗口填写路径；留空沿用默认 Shell 并自动查找 `rg`。Windows 推荐填写 `C:\Program Files\Git\bin\bash.exe`，也支持 `powershell.exe` / `pwsh.exe` / `cmd.exe`。支持 WindowsApps 中的 PowerShell 应用执行别名。启动后显示实际路径，设置会保存。不会静默把旧版 cmd 改成 bash。
- 点击 **停止服务** 后即可修改设置；启动成功会自动保存。运行状态、端口冲突和工具日志直接显示在窗口内。
- 点击窗口关闭按钮后，可选 **隐藏到托盘** 或 **退出程序**，也可取消。隐藏后服务继续运行；Windows 使用右下角托盘，macOS 使用顶部菜单栏图标。右击图标可 **显示窗口** 或 **退出程序**；Windows 双击托盘图标也能恢复窗口。退出会停止服务、终止由服务启动的运行中命令并释放端口。

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
node server.ts <工作区目录> [--port 8765] [--host 127.0.0.1] [--shell <Shell路径>] [--rg <rg路径>]
```

然后在扩展弹窗里把打印出的 URL（`http://127.0.0.1:8765/sse`）添加为服务器。服务默认绑定回环地址，使用扩展实际支持的 legacy SSE 传输（`/sse` + `/messages`，已处理 CORS 与 Private Network Access 预检）。

**工具**

- `read(path, offset?, limit?)` — 带行号输出（`1: ...`），2000 行 / 50KB 截断；图片（png/jpg/gif/webp/bmp）返回图像内容。成功读取文本时记录本连接的文件哈希。
- `write(path, content, contextVersion?)` — 创建（自动建父目录）或整体覆盖；缺少 `content` 会报错，明确传空字符串才表示清空。
- `edit(path, oldText, newText, replaceAll?, contextVersion?)` 或 `edit(path, edits: [...], replaceAll?, contextVersion?)` — 精确替换，兼容 LF/CRLF。默认要求唯一匹配；`replaceAll: true` 对所有编辑项启用全部匹配替换。区域仍不得重叠，批量任一失败则全部不落盘。成功返回替换数量和第一处改动附近的行号；失败给出 0 处或多处，可能时附候选行，但不会自动模糊替换。删除时明确传 `newText: ""`。
- `bash(command, timeout?, cwd?, encoding?, contextVersion?)` — 默认 `action: "run"`，等待命令结束。返回任务 ID、状态、退出码、输出尾部和完整日志路径。默认超时 120 秒；不再限制为 600 秒。每次默认从工作区执行，`cd` 不跨调用保持；操作其他项目请传 `cwd`。
- `bash(action: "start", command, cwd?, timeout?, encoding?, contextVersion?)` — 立即返回 `jobId`，默认无超时。`bash(action: "output", jobId)` 查询最新状态和输出，`bash(action: "stop", jobId)` 结束任务，`bash(action: "list")` 找回当前服务内任务。工具数量仍是四个。

任务跨网页断线和重连保留；停止或正常退出本地服务时结束运行中的进程树（Windows 使用 `taskkill /T /F`，POSIX 使用进程组）。不承诺异常崩溃后的进程回收或任务恢复，主动脱离进程树的守护进程不属于此生命周期。日志保存在 `<工作区>/temp/claude-local-jobs/<服务ID>/`，stdout/stderr 分别流式写入 UTF-8 文件，不再有 16MB 缓冲区上限；结果仅保留最近 2000 行 / 50KB，可用 `read` 按行分段读取日志。日志不会自动删除；确认不再需要后手动清理。当前服务最多同时运行 32 个任务，任务索引保留最近 200 条，服务重启后日志仍在，索引不恢复。

Windows 默认 `cmd.exe`，可在界面、`--shell` 或 `CLAUDE_LOCAL_SHELL` 指定 Shell。拒绝误用 `C:\Windows\System32\bash.exe`（WSL 入口）。cmd 默认先切换 UTF-8 代码页，PowerShell 配置 UTF-8 输出；Python 设置 `PYTHONIOENCODING=utf-8`。固定旧编码的程序可传 `encoding: "cp936"` 或 `"utf16le"`；按完整流解码，分块不会破坏多字节字符。同一进程混合多种编码不能可靠自动识别。

ripgrep 先使用界面/CLI 指定路径，否则检查 `PATH` 和 `~/.claude-local/bin/rg(.exe)`；找到后把其目录加入命令环境，实际路径同步给模型。程序不会自动下载可执行文件，未找到时界面明确提示配置路径。

覆盖或编辑已有文件前，必须在同一连接中先 `read`（本连接刚成功写入的文件也可继续编辑）。读取后被其他程序修改、删除，或并发调用已提交其他改动时，操作会拒绝并要求重新读取。文件别名按真实路径处理，同一文件的工具读写排队；已有文件采用同目录临时文件替换，新文件不会覆盖同时出现的外部文件。重连后需要重新读取。该检查不能拦截 `bash` 或外部程序的写入，也不是操作系统级文件锁。

文本先按 BOM 识别 UTF-8/UTF-16 LE/BE；无 BOM 时先严格解码 UTF-8，失败后尝试 CP936/GBK，并验证字节往返一致。无法无损解码、二进制内容或新字符无法用原编码表示时拒绝修改。无 BOM 的其他旧编码不能可靠自动识别。已有文件保留编码和 BOM，新文件默认 UTF-8；整体覆盖保留统一行尾，混合行尾文件要求使用 `edit`，保留未修改区域。多硬链接文件拒绝替换，避免破坏链接关系。

工作区只是默认目录，不是文件权限沙箱；绝对路径和 `bash` 仍使用当前用户权限。本版本未增加命令关键字审批或仅限制文件工具的伪沙箱。

**Skills**

服务启动时扫描以下目录中的 `<名称>/SKILL.md`（同名时项目目录优先于全局），只把每个 skill 的 `name`/`description`/`path` 注入工具描述。任务匹配某个 skill 时，Claude 用 `read` 工具读取完整 `SKILL.md` 再执行——渐进披露，不需要单独的 skill 运行时：

1. `<工作区>/.pi/skills`
2. `~/.pi/agent/skills`
3. `~/.agents/skills`

**AGENTS.md 基础规则**

服务启动时读取 `~/.pi/agent/AGENTS.md`，再按根目录到工作区的顺序读取各级 `AGENTS.md`，相同文件只加载一次。**Claude 网页已验证不能依赖 `initialize.instructions` 交付规则**：基础规则全文、Ponytail 运行指令和 skills 目录集中放入 `read` 的工具描述；初始化响应和其余三个工具不重复正文。工具描述在工具定义加载时提供，不需要先执行 `read` 才能看到。个人通用规则完整保留，客户端扩展状态以本 MCP 的实际环境为准。

文件操作及新命令调用都重新检查目标文件目录（`bash` 使用 `cwd`）及其祖先规则。子目录规则只在对应目录适用；如果工作区设置为整个磁盘，访问具体项目时也会加载项目规则。规则文件不存在时跳过；存在但无法读取/解码时返回错误，不执行操作。

进入新规则作用域或规则发生更新时，`read` 将正文及 `contextVersion` 附在结果中；同一连接连续使用相同版本时不重复正文。`write/edit` 和 `bash` 的 `run/start` 在动态规则版本未匹配时返回 `CONTEXT_REQUIRED`，**本次操作尚未执行**；模型遵循返回规则后，携带该版本重试，无需用户确认。旧版本不能用于修改后的规则；规则删除后返回新的适用规则集。任务查询与取消不受新规则版本阻塞。版本回传保证交付顺序，不代表模型一定理解或遵守规则。

规则、Ponytail 和 skills 会在 `tools/list` 以及工具调用时重新读取，更新不依赖网页主动刷新工具列表。Skills 正文仍按需加载。任意 shell 脚本内部的 `cd`、跨目录文件访问无法靠 `cwd` 完整推断；应主动指定操作项目的 `cwd`，并读取目标文件以获得更具体的规则。

运行端到端自检（启动服务，驱动 SSE 握手并调用全部四个工具）：

```bash
node test.mjs
```

要求 Node >= 22.18（直接以类型擦除方式运行 TypeScript 源码）。

## 许可证

[MIT](LICENSE)
