# CopilotDeck Windows 部署指南

本文适用于 Windows 10/11 和 Windows Server 2022/2025。项目支持两种 Windows 部署方式：

| 方式 | 适用场景 | 数据库 | 命令隔离 | 对外访问 |
| --- | --- | --- | --- | --- |
| Windows 原生 | 单机、个人或可信小团队 | SQLite | 无隔离，命令直接在 Windows 上运行 | 默认仅本机 |
| Docker Desktop | 团队部署、需要容器隔离 | SQLite | Linux 容器隔离 | 可通过端口或反向代理访问 |

如果只是先运行起来，建议从“Windows 原生部署”开始。如果会有不受完全信任的用户，或需要从其他机器访问，请使用 Docker Desktop。

## 1. 通用准备

### 1.1 软件要求

安装以下 64 位软件：

- Node.js 22 或更高版本；建议使用当前受支持的 LTS 版本。
- Git for Windows，并确保 `git.exe` 已加入 `PATH`。
- ripgrep，并确保 `rg.exe` 已加入 `PATH`。
- Docker Desktop（仅 Docker 部署需要），使用 WSL 2 后端和 Linux containers。
- Python（可选）；只有 Agent 需要运行 Python 私有脚本时才需要。

在新的 PowerShell 窗口中验证：

```powershell
node --version
corepack --version
git --version
rg --version
docker version       # 仅 Docker 部署
docker compose version
```

Node.js 版本必须不低于 22。项目固定使用 pnpm 11.15.1，后续命令通过 Corepack 调用正确版本。

### 1.2 获取项目

以下示例把项目放在 `C:\Apps\CopilotDeck`：

```powershell
New-Item -ItemType Directory -Force C:\Apps | Out-Null
Set-Location C:\Apps
git clone <你的 CopilotDeck 仓库 URL> CopilotDeck
Set-Location C:\Apps\CopilotDeck
corepack pnpm --version
```

如果 Corepack 不能获取项目指定的 pnpm 版本，确认机器能够访问 npm registry，然后执行：

```powershell
corepack prepare pnpm@11.15.1 --activate
```

### 1.3 创建 GitHub App

在 GitHub.com 创建 GitHub App，并启用用户授权。默认本机地址使用：

- Homepage URL：`http://localhost:3000`
- Callback URL：`http://localhost:3000/api/auth/github/callback`

至少配置：

- Organization members：Read（启用组织成员校验时需要）。
- Copilot Requests：使用 GitHub 页面提供的最低可用权限。
- User authorization：启用。

将 App 安装到 `.env` 中 `GITHUB_ALLOWED_ORGS` 指定的组织。如果通过域名和 HTTPS 对外提供服务，Homepage URL、Callback URL 和 `PUBLIC_APP_URL` 必须一起改成实际地址，例如：

```text
https://copilot.example.com
https://copilot.example.com/api/auth/github/callback
```

GitHub Enterprise Cloud 需要单独创建一个 GitHub App，并使用 `/api/auth/ghe/callback`。GitHub Enterprise Server 不受 Copilot 支持。

## 2. Windows 原生部署

### 2.1 创建配置文件

在项目根目录运行：

```powershell
Copy-Item .env.example .env
Copy-Item config\repositories.example.yaml config\repositories.yaml
```

不要把 `.env` 提交到 Git。它包含登录和加密所需的密钥。

### 2.2 生成服务密钥

下面的命令每执行一次生成一个随机值：

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
```

执行三次，分别用于：

- `COOKIE_SECRET`
- `SANDBOX_RUNNER_TOKEN`
- `WORKER_CONTROL_TOKEN`

`TOKEN_ENCRYPTION_KEY` 必须由恰好 32 个随机字节生成：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

把结果直接粘贴到 `.env`，不要添加引号或额外空格。

### 2.3 编辑 `.env`

原生部署建议保留以下设置：

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
SANDBOX_RUNNER_URL=http://127.0.0.1:4100
WORKER_CONTROL_URL=http://127.0.0.1:4200
SANDBOX_BACKEND=local
LOCAL_SANDBOX_TMP_ROOT=./data/local-sandbox
WORKER_CONCURRENCY=2
WORKER_POLL_INTERVAL_MS=200
EVENT_POLL_INTERVAL_MS=200

COOKIE_SECRET=<48 字节随机值>
TOKEN_ENCRYPTION_KEY=<32 字节随机值>
SANDBOX_RUNNER_TOKEN=<48 字节随机值>
WORKER_CONTROL_TOKEN=<48 字节随机值>

GITHUB_CLIENT_ID=<GitHub App Client ID>
GITHUB_CLIENT_SECRET=<GitHub App Client Secret>
GITHUB_ALLOWED_ORGS=<允许登录的组织 slug，多个用逗号分隔>
```

如果使用 GitHub Enterprise Cloud，再填写 `GHE_HOST`、`GHE_CLIENT_ID`、`GHE_CLIENT_SECRET` 和对应的允许列表。

### 2.4 配置可访问仓库

编辑 `config\repositories.yaml`。Windows 路径建议使用正斜杠，避免 YAML 反斜杠转义：

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

注意：

- `path` 必须是绝对路径且目录已存在。
- 启用的仓库内容对 Agent 可见。
- 原生模式下，经批准的命令可以修改仓库，也能读取当前 Windows 用户有权访问的其他文件。
- 修改此文件后服务会自动重新加载；无效配置会被拒绝，并继续使用最后一份有效配置。

### 2.5 安装、迁移和构建

```powershell
Set-Location C:\Apps\CopilotDeck
corepack pnpm install --frozen-lockfile
corepack pnpm db:migrate
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm db:validate
```

如果是第一次试运行，也可以先用 `corepack pnpm dev`；正式运行使用生产构建。

### 2.6 启动并验证

```powershell
corepack pnpm start:local
```

保持该窗口运行，然后检查：

- Web：`http://localhost:3000`
- API 就绪状态：`http://localhost:4000/health/ready`
- Sandbox Runner：`http://localhost:4100/health/ready`

也可以从另一个 PowerShell 窗口验证：

```powershell
Invoke-RestMethod http://localhost:4000/health/ready
Invoke-RestMethod http://localhost:4100/health/ready
```

首次登录时，浏览器会跳转到 GitHub。登录用户必须属于配置的组织或企业，并具有 Copilot 权益。

原生生产启动器会一起启动 Web、API、Worker 和 Sandbox Runner。任一组件异常退出后，其余组件也会停止，便于服务管理器发现故障。

### 2.7 使用任务计划程序开机启动

可以通过 Windows Task Scheduler 创建任务：

1. 选择“无论用户是否登录都运行”，使用专门的低权限服务账户。
2. Trigger 选择“At startup”，可延迟 30 秒启动。
3. Program 填写 `C:\Windows\System32\cmd.exe`。
4. Arguments 填写：

   ```text
   /d /c "corepack pnpm start:local >> data\copilotdeck.log 2>&1"
   ```

5. Start in 填写 `C:\Apps\CopilotDeck`。
6. 设置任务失败后自动重启，例如每 1 分钟重试，最多 3 次。
7. 设置“如果任务已在运行，则不启动新实例”。

服务账户必须拥有项目目录、`data` 目录以及所有已配置仓库的读取权限；原生命令执行需要修改仓库时，还必须授予写入权限。

原生启动默认绑定 `127.0.0.1`，只供本机浏览器使用。需要局域网或公网访问时，应改用 Docker 部署并放在 HTTPS 反向代理后面。

## 3. Windows + Docker Desktop 部署

### 3.1 Docker Desktop 设置

确认：

- Docker Desktop 正在运行。
- 使用 WSL 2 engine。
- 当前使用 Linux containers，而不是 Windows containers。
- 项目和目标仓库所在磁盘可被 Docker Desktop 访问。

验证：

```powershell
docker version
docker compose version
docker run --rm hello-world
```

### 3.2 创建配置和密钥

```powershell
Copy-Item .env.example .env
Copy-Item config\repositories.example.yaml config\repositories.yaml
```

按照原生部署的方式生成 `COOKIE_SECRET`、`TOKEN_ENCRYPTION_KEY` 和 `SANDBOX_RUNNER_TOKEN`。Compose 模式不使用 `WORKER_CONTROL_TOKEN`，但保留一个随机值不会产生影响。

### 3.3 分离 Windows 路径和容器路径

Docker Desktop 使用 Windows 宿主路径，但应用容器是 Linux。假设目标仓库位于 `C:\src\platform-api`，在 `.env` 中设置：

```dotenv
PUBLIC_APP_URL=http://localhost:3000
REPOSITORIES_CONFIG_FILE=./config/repositories.yaml

REPO_ROOT=/repo
REPO_HOST_PATH=C:/src/platform-api
REPO_CONTAINER_PATH=/repo
CONTAINER_RUNTIME_SOCKET=/var/run/docker.sock

COOKIE_SECRET=<48 字节随机值>
TOKEN_ENCRYPTION_KEY=<32 字节随机值>
SANDBOX_RUNNER_TOKEN=<48 字节随机值>

GITHUB_CLIENT_ID=<GitHub App Client ID>
GITHUB_CLIENT_SECRET=<GitHub App Client Secret>
GITHUB_ALLOWED_ORGS=<组织 slug>
```

对应的 `config\repositories.yaml` 必须使用容器内路径：

```yaml
repositories:
  - id: platform-api
    displayName: Platform API
    path: /repo
    enabled: true
    sandboxImage: copilot-web-sandbox:local
```

不要在该 Compose 配置中写 `C:/src/platform-api`，因为 API、Worker 和 Sandbox Runner 看到的是 Linux 容器路径 `/repo`。

如需增加多个仓库，需要为每个额外仓库添加 Compose override bind mount，并在 YAML 中使用对应的容器路径。

### 3.4 SQLite Compose 模式

先检查 Compose 展开结果，再启动：

```powershell
docker compose config
docker compose up --build -d
docker compose ps
```

查看日志和健康状态：

```powershell
docker compose logs -f --tail 200
Invoke-RestMethod http://localhost:4000/health/ready
```

SQLite 数据和 Copilot Session 状态保存在项目的 `data` 目录。默认 Worker 并发为 2，SQLite 仍然只有一个写入者，不建议在未压测时提高并发。

常用管理命令：

```powershell
docker compose stop
docker compose start
docker compose down
docker compose up --build -d
```

### 3.5 局域网、域名和 HTTPS

Compose 的 `3000:3000` 和 `4000:4000` 默认可能监听所有接口。生产环境建议：

1. 只向用户开放 Web 端口 3000，限制 API 4000 的入站访问。
2. 使用 IIS、Caddy、Nginx 或企业负载均衡器终止 HTTPS。
3. 将 `PUBLIC_APP_URL` 设置为最终 HTTPS 地址。
4. 在 GitHub App 中把 Homepage URL 和 Callback URL 改为完全相同的域名及协议。
5. 仅在确有需要时创建 Windows Firewall 入站规则。

反向代理必须支持长连接和 Server-Sent Events，并避免对流式响应进行缓冲。

## 4. 备份、升级和恢复

### 4.1 SQLite 模式备份

为保证 SQLite、WAL 和 Copilot 会话状态一致，先停止服务，然后备份：

- 整个 `data` 目录。
- `.env`（加密保存）。
- `config\repositories.yaml`。

恢复时，将这些文件放回相同位置，重新运行 `corepack pnpm db:migrate`，然后启动服务。

### 4.2 升级

升级前先备份并停止服务。原生模式：

```powershell
Set-Location C:\Apps\CopilotDeck
git pull --ff-only
corepack pnpm install --frozen-lockfile
corepack pnpm db:migrate
corepack pnpm build
corepack pnpm start:local
```

Docker SQLite 模式：

```powershell
git pull --ff-only
docker compose up --build -d
```

Compose 中的迁移服务会在应用服务启动前执行数据库迁移。

## 5. 常见问题

### `rg` 或 `git` not found

重新安装对应工具并选择加入 `PATH`，然后关闭所有 PowerShell 窗口再打开。任务计划程序使用的服务账户也必须能访问相同的 `PATH`。

### `corepack pnpm install` 失败

检查 npm registry 网络、代理和企业 CA。需要代理时，在启动任务使用的账户环境中配置 `HTTPS_PROXY`；企业 CA 可通过 `NODE_EXTRA_CA_CERTS` 指向 PEM 证书文件。

### Prisma 文件被占用或迁移失败

先停止所有 CopilotDeck Node 进程，再运行迁移。确认服务账户可以写入项目的 `data` 目录，并检查杀毒软件是否锁定 SQLite 文件或 Prisma engine。

### 登录后提示无权限

检查：

- `GITHUB_ALLOWED_ORGS`/`GITHUB_ALLOWED_ENTERPRISES` 是否使用正确 slug。
- GitHub App 是否已安装到目标组织或企业。
- Organization members 权限是否为 Read。
- 用户是否拥有 Copilot 权益。
- Callback URL 是否与当前访问地址完全一致。

### 仓库配置加载失败

路径必须是绝对路径且真实存在。原生配置使用 `C:/...`；Docker 配置使用 `/repo` 等容器路径。查看 API、Worker 和 Sandbox Runner 日志中的 repository registry 错误。

### Docker 报 bind mount 或路径不存在

确认 `REPO_HOST_PATH` 使用 `C:/...` 格式，目标磁盘对 Docker Desktop 可用，并确保 `REPO_CONTAINER_PATH` 与 `repositories.yaml` 中的路径一致。路径中有空格时不要额外添加嵌套引号；`.env` 中直接使用完整路径。

### Sandbox Runner 无法连接 Docker socket

确认 Docker Desktop 使用 Linux containers，`CONTAINER_RUNTIME_SOCKET=/var/run/docker.sock` 未被错误改为 Windows named pipe，并查看 `sandbox-runner` 容器日志。

### 端口被占用

```powershell
Get-NetTCPConnection -LocalPort 3000,4000,4100,4200 -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,State,OwningProcess
```

原生模式可在 `.env` 中调整 API、Sandbox Runner 和 Worker control 端口；修改后也要同步更新对应 URL。Web 端口由生产启动器固定为 3000。

### Agent 命令在 Windows 下语法错误

原生模式的普通 shell 命令由 `cmd.exe` 执行，不是 Bash。使用 Windows 命令语法。标记为 `interpreter: shell` 的私有脚本由 Windows PowerShell 执行；Node 和 Python 脚本使用对应解释器直接运行。Docker 模式中的命令运行在 Linux `/bin/sh` 下。

## 6. 上线检查清单

- [ ] Node、Git 和 ripgrep 版本检查通过。
- [ ] 四个服务密钥均已替换，且没有提交 `.env`。
- [ ] GitHub App Callback URL 与 `PUBLIC_APP_URL` 匹配。
- [ ] 组织或企业允许列表配置正确。
- [ ] 所有仓库路径均存在，且只开放了必要仓库。
- [ ] `pnpm typecheck`、`pnpm test`、`pnpm build` 和 `pnpm db:validate` 通过。
- [ ] API 和 Sandbox Runner 健康检查返回 ready。
- [ ] 已完成一次 GitHub 登录和对话测试。
- [ ] 已测试命令审批、停止和超时处理。
- [ ] 已制定 `data` 目录的备份策略。
- [ ] 对外部署已启用 HTTPS，并限制 API 和内部服务的网络访问。
