# macOS 本机部署

GithubCopilotWebUI 在 macOS 上以本机 Node.js 进程运行，使用 SQLite 保存数据。命令和私有脚本直接以启动 GithubCopilotWebUI 的 macOS 账户身份执行，不提供操作系统级隔离。

本文同时适用于 Apple Silicon 和 Intel Mac。示例以 Apple Silicon 的 Homebrew 默认路径 `/opt/homebrew` 为主；Intel Mac 通常使用 `/usr/local`。

## 1. 环境要求

- macOS 13 或更高版本。
- Node.js 22 或更高版本。
- Corepack 和 pnpm 11。
- Git 和 ripgrep (`rg`)。
- 能访问 GitHub.com 或配置的 GitHub Enterprise Cloud。

使用 Homebrew 安装依赖：

```bash
xcode-select --install
brew install node@22 git ripgrep
echo "export PATH=\"$(brew --prefix node@22)/bin:$(brew --prefix)/bin:\$PATH\"" >> ~/.zprofile
source ~/.zprofile
corepack enable
corepack prepare pnpm@11.15.1 --activate
```

上述命令通过 `brew --prefix` 自动适配 Apple Silicon 和 Intel Mac。验证环境：

```bash
node --version
corepack --version
pnpm --version
git --version
rg --version
node -p 'process.arch'
```

Apple Silicon 原生 Node.js 应输出 `arm64`。避免混用 Rosetta 下的 x64 Node.js 和 arm64 原生依赖。

建议使用专门的低权限 macOS 账户运行应用。该账户必须能够读取应用目录和已注册仓库，并能够写入 `data` 目录。若允许 Agent 修改仓库，还需要相应写入权限。

生产目录建议放在：

```text
/Users/<运行账户>/Applications/GithubCopilotWebUI
/Users/<运行账户>/Developer/<repository>
```

尽量不要把服务目录或仓库放在 Desktop、Documents、Downloads、iCloud Drive 或受保护的外接磁盘中，否则 macOS 隐私控制可能要求为 Terminal、Node.js 或后台服务授予额外权限。不要为了方便直接授予“完全磁盘访问权限”；优先调整目录和最小文件权限。

## 2. 创建配置

在项目目录执行：

```bash
cp .env.example .env
cp config/repositories.example.yaml config/repositories.yaml
mkdir -p data/logs
chmod 600 .env
chmod 700 data
```

使用 Node.js 生成四个相互独立的随机值。`TOKEN_ENCRYPTION_KEY` 使用 32 字节，其余服务密钥可使用 48 字节：

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

至少设置：

```dotenv
NODE_ENV=production
LOG_LEVEL=info
LOG_DIR=./data/logs
PUBLIC_APP_URL=http://localhost:3000
API_HOST=127.0.0.1
API_PORT=4000
SANDBOX_RUNNER_HOST=127.0.0.1
SANDBOX_RUNNER_PORT=4100
WORKER_CONTROL_HOST=127.0.0.1
WORKER_CONTROL_PORT=4200

DATABASE_URL=file:../../../data/copilot.db?connection_limit=1
REPOSITORIES_CONFIG=./config/repositories.yaml
COPILOT_HOME=./data/copilot
LOCAL_SANDBOX_TMP_ROOT=./data/local-sandbox

SANDBOX_RUNNER_URL=http://127.0.0.1:4100
WORKER_CONTROL_URL=http://127.0.0.1:4200
COOKIE_SECRET=<48 字节随机值>
TOKEN_ENCRYPTION_KEY=<32 字节随机值>
SANDBOX_RUNNER_TOKEN=<48 字节随机值>
WORKER_CONTROL_TOKEN=<另一个 48 字节随机值>

GITHUB_CLIENT_ID=<GitHub App Client ID>
GITHUB_CLIENT_SECRET=<GitHub App Client Secret>
GITHUB_ALLOWED_ORGS=<允许登录的组织 slug，多个用逗号分隔>
```

如果使用 GitHub Enterprise Cloud，再填写 `GHE_HOST`、`GHE_CLIENT_ID`、`GHE_CLIENT_SECRET` 和对应允许列表。

GitHub App 的本机配置通常为：

- Homepage URL：`http://localhost:3000`
- GitHub.com Callback URL：`http://localhost:3000/api/auth/github/callback`
- GHE Callback URL：`http://localhost:3000/api/auth/ghe/callback`

`PUBLIC_APP_URL`、浏览器访问地址和 GitHub App Callback URL 的协议、域名及端口必须一致。

## 3. 配置仓库

编辑 `config/repositories.yaml`，使用真实的绝对路径：

```yaml
repositories:
  - id: platform-api
    displayName: Platform API
    path: /Users/copilot/Developer/platform-api
    enabled: true

  - id: web-client
    displayName: Web Client
    path: /Users/copilot/Developer/web-client
    enabled: true
```

路径必须是绝对路径且目录已经存在。不要使用 `~`、环境变量或尚未挂载的网络目录。仓库内容和 skill 对所有授权用户可见。配置修改会自动重新加载；无效更新会被拒绝并继续使用最后一份有效配置。

检查运行账户是否拥有所需权限：

```bash
test -r /Users/copilot/Developer/platform-api && echo readable
test -w /Users/copilot/Developer/platform-api && echo writable
git -C /Users/copilot/Developer/platform-api status --short
```

本地命令和私有脚本拥有运行账户的完整权限。只注册可信仓库，且不要让该账户访问生产密钥、SSH 私钥或无关敏感目录。

## 4. 安装、迁移和构建

```bash
cd /Users/copilot/Applications/GithubCopilotWebUI
corepack pnpm install --frozen-lockfile
corepack pnpm db:migrate
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm db:validate
```

开发环境可使用：

```bash
corepack pnpm dev
```

首次安装若出现原生模块架构错误，确认 `node -p 'process.arch'` 与当前终端架构一致，删除由另一架构生成的 `node_modules` 后重新安装。不要在 arm64 与 Rosetta 终端之间共用同一份依赖目录。

## 5. 启动和验证

```bash
corepack pnpm start:local
```

检查：

- Web：`http://localhost:3000`
- API：`http://localhost:4000/health/ready`
- Local Execution Runner：`http://localhost:4100/health/ready`

```bash
curl --fail --silent http://localhost:4000/health/ready
curl --fail --silent http://localhost:4100/health/ready
```

生产启动器会一起启动 Web、API、Worker 和 Local Execution Runner。任一组件异常退出后，其他组件也会停止，方便服务管理器发现故障。

完成一次浏览器验证：

1. 使用允许组织或企业中的 GitHub 账户登录。
2. 创建 Session 并选择已配置仓库。
3. 发送一个只读问题，确认流式输出正常。
4. 在 Interactive 模式批准一条无副作用命令，例如 `git status --short`。
5. 测试 Stop generating、Session 重命名和永久删除。

## 6. 使用 launchd 自动启动

macOS 的 `launchd` 不会读取 `.zprofile`、`.zshrc` 等交互式 shell 配置，因此必须在 plist 中写入完整可执行文件路径和 `PATH`。

先查找 Corepack 路径：

```bash
command -v corepack
brew --prefix node@22
mkdir -p ~/Library/LaunchAgents
```

创建 `~/Library/LaunchAgents/com.local.githubcopilotwebui.plist`。把 `YOUR_USER`、项目路径和 Corepack 路径替换为真实值：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.local.githubcopilotwebui</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@22/bin/corepack</string>
    <string>pnpm</string>
    <string>start:local</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USER/Applications/GithubCopilotWebUI</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USER/Applications/GithubCopilotWebUI/data/launchd.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USER/Applications/GithubCopilotWebUI/data/launchd.stderr.log</string>
</dict>
</plist>
```

Intel Mac 把 `/opt/homebrew` 改为实际的 `/usr/local` 路径。验证并加载：

```bash
plutil -lint ~/Library/LaunchAgents/com.local.githubcopilotwebui.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.local.githubcopilotwebui.plist
launchctl kickstart -k "gui/$(id -u)/com.local.githubcopilotwebui"
launchctl print "gui/$(id -u)/com.local.githubcopilotwebui"
```

查看日志：

```bash
tail -f data/launchd.stdout.log data/launchd.stderr.log
find data/logs -maxdepth 6 -type f -name '*.log' -print
```

停止或卸载：

```bash
launchctl kill SIGTERM "gui/$(id -u)/com.local.githubcopilotwebui"
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.local.githubcopilotwebui.plist
```

由于配置了 `KeepAlive`，`launchctl kill` 只适合测试重启，进程会再次启动。备份、升级或维护时应使用 `bootout` 完整卸载任务。

用户级 LaunchAgent 只在该用户登录后运行。确实需要开机后、登录前运行时，可由管理员将等价配置安装到 `/Library/LaunchDaemons`，显式设置 `UserName` 和文件权限；不要让服务以 `root` 身份执行 Agent 命令。

### 远程访问和 HTTPS

默认只绑定 `127.0.0.1`。需要从其他机器访问时，在同一台 Mac 上使用 Caddy、Nginx 或企业网关终止 HTTPS，只代理 Web 的 `127.0.0.1:3000`，不要公开 4000、4100 或 4200 端口。

以 Caddy 为例：

```caddyfile
copilot.example.com {
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1
  }
}
```

同时把 `.env` 的 `PUBLIC_APP_URL` 和 GitHub App Homepage/Callback URL 改为相同的 HTTPS 域名。代理必须支持 Server-Sent Events，并避免缓冲流式响应。macOS 防火墙只需允许反向代理接收入站连接，不应允许内部服务直接对外监听。

## 7. 备份、恢复和升级

一致性离线备份前停止应用：

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.local.githubcopilotwebui.plist
```

一起备份整个 `data` 目录、加密保存的 `.env` 和 `config/repositories.yaml`：

```bash
tar -czf "githubcopilotwebui-backup-$(date +%Y%m%d-%H%M%S).tar.gz" data .env config/repositories.yaml
```

恢复后检查所有者和权限，运行数据库迁移，再启动服务：

```bash
chmod 600 .env
chmod 700 data
corepack pnpm db:migrate
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.local.githubcopilotwebui.plist
launchctl kickstart -k "gui/$(id -u)/com.local.githubcopilotwebui"
```

升级流程：

```bash
cd /Users/copilot/Applications/GithubCopilotWebUI
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.local.githubcopilotwebui.plist
git pull --ff-only
corepack pnpm install --frozen-lockfile
corepack pnpm db:migrate
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.local.githubcopilotwebui.plist
launchctl kickstart -k "gui/$(id -u)/com.local.githubcopilotwebui"
```

升级前始终备份数据。不要把 `data/copilot.db` 放在 iCloud Drive、NFS、SMB 或其他网络同步目录。

## 8. 常见问题

### `node`、`pnpm`、`rg` 或 `git` not found

交互式终端正常但 LaunchAgent 失败，通常是 plist 中的 `PATH` 不完整。使用 `command -v` 和 `brew --prefix` 获取真实路径，修改 plist 后执行 `bootout` 和 `bootstrap` 重新加载。

### `bad CPU type in executable` 或原生模块架构不匹配

```bash
uname -m
node -p 'process.arch'
file "$(command -v node)"
```

确保终端、Node.js 和依赖使用同一架构。Apple Silicon 优先使用 arm64 Homebrew，不要从 Rosetta 终端复用已有 `node_modules`。

### `Operation not permitted` 或仓库不可读

检查仓库是否位于 Desktop、Documents、Downloads、iCloud Drive 或外接磁盘等受 macOS 隐私控制的位置。优先把仓库移至运行账户的 `~/Developer`，并确认目录所有者和 Unix 权限。只有确有业务需要时才为具体终端或服务进程授予额外权限。

### Prisma 迁移失败或 SQLite 文件被占用

停止 GithubCopilotWebUI 后再迁移。确认运行账户可以写入 `data`，数据库没有位于网络或同步文件系统中：

```bash
ls -la data
lsof data/copilot.db data/copilot.db-wal 2>/dev/null
```

### 登录后提示无权限

检查 GitHub 组织/企业 slug、GitHub App 安装范围、成员读取权限、用户 Copilot 权益，以及 Callback URL 是否与 `PUBLIC_APP_URL` 完全一致。

### 仓库配置加载失败

确认路径是已存在的绝对路径，运行账户可以读取，并查看 API、Worker 和 Local Execution Runner 日志。配置中不能使用 `~` 或环境变量。

### 端口被占用

```bash
for port in 3000 4000 4100 4200; do
  lsof -nP -iTCP:"$port" -sTCP:LISTEN
done
```

可在 `.env` 中调整 API、Execution Runner 和 Worker control 端口；修改端口后同步修改对应 URL。Web 端口由生产启动器固定为 3000。

### Agent 命令在终端可用，但后台运行时报 `command not found`

普通 shell 命令通过 `/bin/sh -lc` 执行，后台进程不会继承交互式 zsh 的别名、函数或版本管理器初始化。把必要工具放入 LaunchAgent 的 `PATH`，或在脚本中使用绝对路径。私有脚本的 `interpreter: shell` 使用 `/bin/sh`，Node 和 Python 脚本分别使用 `node` 和 `python3`；`direct` 脚本需要有效 shebang 和可执行权限。

### LaunchAgent 不断重启

`KeepAlive` 会在进程失败后重新启动。查看 `data/launchd.stderr.log`，确认已经执行生产构建、`.env` 可读、端口没有被占用，并检查 plist 中 Corepack 和工作目录的绝对路径。修复前可先执行 `launchctl bootout` 停止重试。

## 9. 上线检查清单

- [ ] Node、pnpm、Git 和 ripgrep 版本及架构检查通过。
- [ ] 四个服务密钥已替换，`.env` 权限为 `600` 且未提交到 Git。
- [ ] GitHub App Callback URL 与 `PUBLIC_APP_URL` 匹配。
- [ ] 组织或企业允许列表配置正确。
- [ ] 所有仓库路径均存在，且只注册了可信仓库。
- [ ] 服务使用专门的低权限账户，不以 `root` 运行。
- [ ] 类型检查、测试、构建和数据库校验通过。
- [ ] API 和 Local Execution Runner 健康检查返回 ready。
- [ ] 已测试 GitHub 登录、流式输出、审批、停止和超时。
- [ ] LaunchAgent 重启和登录启动验证通过。
- [ ] 已完成一次备份与恢复演练。
- [ ] 对外访问启用了 HTTPS，内部端口仍只绑定 loopback。
- [ ] 用户已明确了解本地命令和脚本没有隔离并拥有运行账户权限。
