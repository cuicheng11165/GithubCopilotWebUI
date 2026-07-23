# Windows 本机部署

GithubCopilotWebUI 在 Windows 上以本机 Node.js 进程运行，使用 SQLite 保存数据。命令和私有脚本直接以启动 GithubCopilotWebUI 的 Windows 账户身份执行，不提供操作系统级隔离。

## 1. 环境要求

- 64 位 Node.js 22 或更高版本。
- Corepack 和 pnpm 11。
- Git for Windows。
- ripgrep (`rg`)。
- 能访问 GitHub.com 或配置的 GitHub Enterprise Cloud。

验证环境：

```powershell
node --version
corepack --version
git --version
rg --version
```

建议使用专门的低权限服务账户运行应用。该账户必须能够读取应用目录和已注册仓库，并能够写入 `data` 目录。若允许 Agent 修改仓库，还需要相应写入权限。

## 2. 创建配置

在项目目录执行：

```powershell
Copy-Item .env.example .env
Copy-Item config\repositories.example.yaml config\repositories.yaml
```

使用 Node.js 生成四个相互独立的随机值。`TOKEN_ENCRYPTION_KEY` 使用 32 字节，其余服务密钥可使用 48 字节：

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

至少设置：

```dotenv
NODE_ENV=production
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

## 3. 配置仓库

编辑 `config\repositories.yaml`。Windows 路径建议使用正斜杠：

```yaml
repositories:
  - id: platform-api
    displayName: Platform API
    path: C:/src/platform-api
    enabled: true

  - id: web-client
    displayName: Web Client
    path: D:/work/web-client
    enabled: true
```

路径必须是绝对路径且目录已经存在。仓库内容和 skill 对所有授权用户可见。配置修改会自动重新加载；无效更新会被拒绝并继续使用最后一份有效配置。

## 4. 安装、迁移和构建

```powershell
Set-Location C:\Apps\GithubCopilotWebUI
corepack pnpm install --frozen-lockfile
corepack pnpm db:migrate
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm db:validate
```

开发环境可使用：

```powershell
corepack pnpm dev
```

## 5. 启动和验证

```powershell
corepack pnpm start:local
```

检查：

- Web：`http://localhost:3000`
- API：`http://localhost:4000/health/ready`
- Local Execution Runner：`http://localhost:4100/health/ready`

```powershell
Invoke-RestMethod http://localhost:4000/health/ready
Invoke-RestMethod http://localhost:4100/health/ready
```

生产启动器会一起启动 Web、API、Worker 和 Local Execution Runner。任一组件异常退出后，其他组件也会停止，方便服务管理器发现故障。

## 6. 开机启动

可通过 Windows Task Scheduler 创建任务：

1. 使用专门的低权限服务账户，选择“无论用户是否登录都运行”。
2. Trigger 选择“At startup”，可延迟 30 秒。
3. Program 填写 `C:\Windows\System32\cmd.exe`。
4. Arguments 填写：

   ```text
   /d /c "corepack pnpm start:local >> data\github-copilot-web-ui.log 2>&1"
   ```

5. Start in 填写项目绝对路径。
6. 配置失败后自动重启，并避免重复实例。

本机启动默认绑定 `127.0.0.1`。需要远程访问时，应使用 IIS、Caddy、Nginx 或企业网关提供 HTTPS 和身份边界，只对外公开 Web 端口。反向代理必须支持 Server-Sent Events，并避免缓冲流式响应。

## 7. 备份、恢复和升级

一致性离线备份前停止应用，然后一起备份：

- 整个 `data` 目录。
- 加密保存的 `.env`。
- `config\repositories.yaml`。

恢复后运行 `corepack pnpm db:migrate` 再启动。

升级流程：

```powershell
Set-Location C:\Apps\GithubCopilotWebUI
git pull --ff-only
corepack pnpm install --frozen-lockfile
corepack pnpm db:migrate
corepack pnpm build
corepack pnpm start:local
```

## 8. 常见问题

### `rg` 或 `git` not found

重新安装并加入 `PATH`，关闭 PowerShell 后重新打开。任务计划程序使用的服务账户也必须拥有相同工具路径。

### Prisma 文件被占用或迁移失败

停止所有 GithubCopilotWebUI Node 进程后再迁移。确认服务账户可以写入 `data` 目录，并检查杀毒软件是否锁定 SQLite 文件或 Prisma engine。

### 登录后提示无权限

检查 GitHub 组织/企业 slug、GitHub App 安装范围、成员读取权限、用户 Copilot 权益，以及 Callback URL 是否与 `PUBLIC_APP_URL` 完全一致。

### 仓库配置加载失败

确认路径是已存在的绝对路径，使用当前服务账户可以读取，并查看 API、Worker 和 Local Execution Runner 日志。

### 端口被占用

```powershell
Get-NetTCPConnection -LocalPort 3000,4000,4100,4200 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,State,OwningProcess
```

可在 `.env` 中调整 API、Execution Runner 和 Worker control 端口；修改端口后同步修改对应 URL。

### Agent 命令语法错误

普通 shell 命令由 `cmd.exe` 执行。标记为 `interpreter: shell` 的私有脚本由 Windows PowerShell 执行；Node 和 Python 脚本使用对应解释器直接运行。

## 9. 上线检查清单

- [ ] Node、Git 和 ripgrep 版本检查通过。
- [ ] 四个服务密钥已替换，且未提交 `.env`。
- [ ] GitHub App Callback URL 与 `PUBLIC_APP_URL` 匹配。
- [ ] 组织或企业允许列表配置正确。
- [ ] 所有仓库路径均存在，且只注册了可信仓库。
- [ ] 类型检查、测试、构建和数据库校验通过。
- [ ] API 和 Local Execution Runner 健康检查返回 ready。
- [ ] 已测试 GitHub 登录、审批、停止和超时。
- [ ] 已制定 `data` 目录备份策略。
- [ ] 对外访问启用了 HTTPS，内部端口仍只绑定 loopback。
- [ ] 用户已明确了解本地命令和脚本没有隔离并拥有服务账户权限。
