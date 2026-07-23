# GithubCopilotWebUI

[中文](#中文) | [English](#english)

<a id="中文"></a>

## 中文

[English](#english)

GithubCopilotWebUI 是一个面向团队或个人本地使用的 GitHub Copilot Agent Web 界面。它把 GitHub Copilot Agent 的会话能力封装成类似 ChatGPT 的网页体验：管理员预先登记可信代码仓库，用户通过 GitHub 身份登录后，可以在浏览器中选择仓库、创建多轮会话、向 Copilot 提问，并在需要时审批命令、URL 访问或仓库内私有脚本的执行。

本文只介绍项目的核心功能与基础架构，不包含部署步骤。

## 项目定位

GithubCopilotWebUI 适合在一台受信任机器上，为多个已授权用户提供统一的 Copilot Agent 入口。项目关注以下目标：

- **集中管理仓库入口**：管理员通过仓库配置文件登记可用仓库，用户只能在这些仓库中创建会话。
- **保留用户身份边界**：每个用户使用自己的 GitHub / GitHub Enterprise Cloud OAuth 身份和 Copilot 权益。
- **提供可审计的交互流程**：会话、消息、审批请求、事件流与审计日志都会写入 SQLite。
- **降低 Agent 执行风险**：默认禁用 Copilot SDK 内置写入/编辑工具，只暴露本项目定义的仓库读取、搜索和受审批执行工具。
- **支持多会话并发**：同一用户可以创建多个会话，不同用户也可以并发使用；同一会话内的消息按顺序处理。

## 基本功能

### 身份认证与访问控制

- 支持 GitHub.com OAuth，并可额外配置一个 GitHub Enterprise Cloud OAuth 提供方。
- 支持按组织或企业成员身份进行 allowlist 校验。
- 用户的 GitHub App token 会加密后存储。
- 浏览器会话使用 HttpOnly Cookie，修改类请求需要 CSRF Token。
- 所有会话操作都会校验所有权，用户只能访问自己的会话与消息。

### 仓库选择与仓库上下文

- 管理员在 `config/repositories.yaml` 中登记本机上的可信仓库。
- API 会返回每个启用仓库的基本信息，包括显示名称、当前分支、HEAD SHA、工作区是否有未提交改动等。
- Agent 可以通过只读工具查看仓库树、读取 UTF-8 文本文件、执行文本搜索和获取 Git 状态。
- 仓库路径访问会阻止绝对路径、父目录穿越以及逃逸仓库根目录的符号链接。

### 多轮聊天会话

- 用户可以创建、切换、重命名和删除会话。
- 每个会话绑定一个仓库、一个模型和一组审批设置。
- 用户消息会入队为 Turn，由 Worker 异步处理。
- SSE 事件流支持实时展示 Assistant 增量输出、工具执行状态、审批请求和 Turn 结果。
- 消息发送使用 `Idempotency-Key`，用于避免重复提交同一轮请求。

### 模型与 Copilot Agent 集成

- Worker 使用 `@github/copilot-sdk` 启动 Copilot runtime。
- Copilot runtime 运行在 `mode: "empty"`，不会默认开放 SDK 内置工具。
- 项目只向 Agent 暴露自定义工具，并显式排除 `builtin:*` 与 `mcp:*` 工具。
- Worker 使用用户自己的 GitHub token 查询可用模型，并在会话中传递对应的 Copilot 身份。
- Copilot SDK 会话状态保存在本机数据目录中，便于恢复和删除指定会话状态。

### 技能发现

- 项目会扫描仓库中的技能目录：
  - `.github/skills`
  - `.agents/skills`
  - `.claude/skills`
- 每个技能目录下的 `SKILL.md` 可通过 YAML frontmatter 提供名称和描述。
- 重名技能、frontmatter 错误等情况会以 warning 形式返回。
- Worker 会为当前会话准备技能视图，并将有效技能目录传给 Copilot SDK。

### 执行审批

项目内置三类需要审批的执行能力：

| 范围 | 工具 | 说明 |
| --- | --- | --- |
| `shell` | `execute_shell` | 在所选仓库上下文中执行本机 shell 命令。 |
| `url` | `fetch_url` | 通过受控网络边界抓取公开 HTTP/HTTPS URL。 |
| `private-script` | `run_private_script` | 运行仓库或私有技能中的脚本，支持 direct、shell、node、python 等解释器模式。 |

会话支持三种审批模式：

- **interactive**：每次执行都需要用户在界面中确认。
- **session-scoped**：仅对会话配置中指定的范围自动批准，其余仍需确认。
- **allow-all**：自动批准所有受支持范围的执行请求。

> 注意：这些审批模式只控制执行是否可以开始，并不构成操作系统级沙箱。被批准的命令或脚本会以运行本服务的系统用户身份执行。

### 停止、恢复与删除

- 用户可以停止正在排队或运行中的 Turn。
- 登出时会尝试停止该用户仍处于活跃状态的会话。
- Worker 启动时会恢复之前处于运行中或等待审批状态的 Turn，将它们重新排队，并使未完成审批过期。
- 删除会话时，API 会要求 Worker 同步删除对应 Copilot SDK 状态；如果 Worker 无法确认删除，则不会删除数据库历史。

### 日志与审计

- API 与 Worker 使用结构化日志。
- 会话相关日志会按用户和会话分流写入：`LOG_DIR/users/<userId>/sessions/<sessionId>/`。
- 用户输入、Agent 完整回复、审批决策、生命周期事件等会被记录到数据库或日志中。
- SQLite 保存用户、GitHub 账户、Web Session、聊天会话、消息、Turn、权限请求、事件流和审计日志。

## 基本架构

项目是一个 pnpm workspace，按运行进程和共享包拆分代码。

```text
Browser
  |
  v
apps/web (Next.js)
  |
  v
apps/api (Fastify HTTP API)
  |
  +--> packages/db (Prisma + SQLite)
  |
  +--> packages/repository-tools (仓库配置、Git 信息、文件读取、搜索、技能扫描)
  |
  v
apps/worker (Copilot SDK Worker)
  |
  +--> packages/db (Turn 队列、消息、事件、审批状态)
  |
  +--> packages/repository-tools (构造 Agent 仓库工具)
  |
  +--> apps/sandbox-runner (命令、URL、私有脚本执行边界)
  |
  v
GitHub Copilot SDK / 本机仓库 / 本机执行环境
```

### `apps/web`：浏览器界面

`apps/web` 是 Next.js 前端应用，负责登录入口、仓库/模型/会话选择、聊天消息展示、权限审批卡片和实时事件消费。它通过 `apps/web/lib/api.ts` 调用后端 API，并通过 SSE 接收会话事件。

主要职责：

- 展示当前用户、可用仓库和可用模型。
- 创建和管理聊天会话。
- 渲染用户消息、Assistant 消息、工具结果和审批请求。
- 在用户批准或拒绝权限请求后，将决策提交给 API。

### `apps/api`：HTTP API 与业务入口

`apps/api` 是 Fastify 服务，是 Web 前端和后端异步任务之间的主要边界。

主要职责：

- 处理 OAuth 登录、回调、登出和 Web Session。
- 校验认证状态、CSRF Token、会话所有权和请求参数。
- 读取仓库注册表并返回仓库元数据。
- 创建、读取、更新、删除聊天会话。
- 接收用户消息，创建 Message 和 Turn，并写入事件流。
- 提供 SSE 事件流，支持通过 `Last-Event-ID` 续接。
- 处理审批请求的批准或拒绝。
- 调用 Worker 控制接口停止或删除会话。

### `apps/worker`：Agent 调度与 Copilot SDK 集成

`apps/worker` 是异步处理核心。它轮询数据库中排队的 Turn，为每个 Turn 恢复或创建 Copilot SDK 会话，并将 Agent 产生的事件持久化。

主要职责：

- 按 `WORKER_CONCURRENCY` 控制并发处理能力。
- 保证同一会话同一时间只处理一个 Turn。
- 解密当前用户的 GitHub token，并以该身份启动 Copilot 会话。
- 为 Agent 注册项目定义的工具，包括仓库只读工具和受审批执行工具。
- 将 Assistant 增量、完整回复、工具开始/完成、审批请求、Turn 完成/失败等写入事件表。
- 处理停止请求、会话删除请求和 Worker 重启后的任务恢复。

### `apps/sandbox-runner`：本机执行代理

`sandbox-runner` 负责承接 Worker 发来的执行请求，包括 shell 命令、URL 获取和私有脚本执行。它提供的是一个受控入口，而不是强隔离沙箱。

主要职责：

- 在指定仓库上下文中启动命令或脚本。
- 管理会话关联的执行进程，支持按会话停止。
- 对 URL 获取做协议、响应大小等基础限制。
- 将执行结果返回给 Worker，再由 Worker 写入消息和事件流。

### `packages/contracts`：共享类型与协议

`packages/contracts` 使用 Zod 定义前后端共享的数据结构和输入校验规则，例如审批模式、会话状态、仓库摘要、消息、权限请求和事件类型。

该包的作用是让 Web、API 和 Worker 对同一组业务对象保持一致理解。

### `packages/db`：数据访问层

`packages/db` 封装 Prisma Client 和 SQLite schema。数据库中主要模型包括：

- `User`：应用用户。
- `GitHubAccount`：用户绑定的 GitHub 身份与加密 token。
- `WebSession`：浏览器登录会话和 CSRF Token。
- `ChatSession`：聊天会话配置、状态和仓库快照。
- `Turn`：用户一次提问对应的异步处理任务。
- `Message`：用户、Assistant、系统和工具消息。
- `SessionEvent`：可回放的 SSE 事件流。
- `PermissionRequest`：等待用户决策的执行审批。
- `AuditLog`：关键动作审计记录。

### `packages/repository-tools`：仓库工具层

`packages/repository-tools` 管理仓库配置与安全的仓库访问能力。

主要职责：

- 加载和监听 `config/repositories.yaml`。
- 校验仓库 ID、显示名、绝对路径、重复路径等配置。
- 获取 Git 分支、HEAD SHA 和 dirty 状态。
- 扫描仓库技能目录并解析 `SKILL.md` frontmatter。
- 提供受限制的文件树、文件读取和文本搜索能力。
- 阻止路径穿越、危险目录读取和逃逸仓库根目录的符号链接。

### `packages/logging`：日志封装

`packages/logging` 提供项目统一的 Pino 日志能力，并支持按用户、会话和服务拆分日志输出。API 和 Worker 都通过该包创建服务日志器。

## 核心数据流

### 创建会话

1. 用户在 Web 端选择仓库、模型和审批模式。
2. Web 调用 API 创建会话。
3. API 校验用户身份和仓库配置。
4. API 读取仓库 Git 状态并扫描技能。
5. API 在 SQLite 中创建 `ChatSession`，并返回给 Web。

### 发送消息

1. 用户在 Web 端发送消息。
2. API 校验会话所有权和 `Idempotency-Key`。
3. API 创建用户 `Message` 和排队状态的 `Turn`。
4. Worker 轮询到该 Turn 后，将其标记为运行中。
5. Worker 创建或恢复 Copilot SDK 会话，并传入仓库、模型、技能和工具配置。
6. Agent 处理用户请求；过程中产生的增量输出、工具事件和审批请求会写入 `SessionEvent`。
7. Web 通过 SSE 实时消费这些事件并更新界面。
8. Turn 完成后，Worker 保存 Assistant 完整回复，并将会话恢复为空闲或继续处理下一条排队消息。

### 执行审批

1. Agent 请求执行 shell、URL 或私有脚本工具。
2. Worker 根据会话审批模式判断是否自动批准。
3. 如果需要人工确认，Worker 创建 `PermissionRequest`，并把会话状态设为 `waiting-approval`。
4. Web 展示审批卡片。
5. 用户批准或拒绝后，API 更新审批状态并写入事件。
6. Worker 继续执行或拒绝该工具调用。

## 目录速览

```text
apps/
  api/              Fastify API、OAuth、认证、会话和事件接口
  web/              Next.js 前端界面
  worker/           Turn 调度、Copilot SDK 集成、工具注册和恢复逻辑
  sandbox-runner/   本机命令、URL 和私有脚本执行代理
packages/
  contracts/        前后端共享 Zod schema 与 TypeScript 类型
  db/               Prisma schema、迁移脚本和数据库客户端
  logging/          统一日志封装
  repository-tools/ 仓库注册表、Git 信息、技能扫描和只读仓库工具
config/             仓库配置示例与本地仓库配置
scripts/            本地开发和组合启动脚本
docs/               API、存储和平台相关补充文档
```

## 安全边界说明

GithubCopilotWebUI 不是强沙箱系统。虽然项目限制了 Agent 默认可用工具，并通过审批机制控制 shell、URL 和私有脚本执行，但一旦执行被批准，对应进程仍会以服务进程的操作系统用户身份运行。它可能修改仓库、读取该用户可访问的文件、启动其他进程或访问网络。

因此，本项目应只登记可信仓库，只开放给可信用户，并使用低权限系统账户运行。更完整的安全注意事项请参考 `SECURITY.md`。

---

<a id="english"></a>

## English

[中文](#中文)

GithubCopilotWebUI is a locally oriented GitHub Copilot Agent Web UI for teams or individuals. It wraps GitHub Copilot Agent sessions in a ChatGPT-like browser experience: administrators register trusted repositories in advance, users sign in with GitHub, then select a repository, create multi-turn sessions, ask Copilot questions, and approve command execution, URL access, or repository private scripts when needed.

This README covers the core capabilities and basic architecture. It does not include deployment steps.

## Project Positioning

GithubCopilotWebUI is designed to provide a unified Copilot Agent entry point for multiple authorized users on a trusted machine. The project focuses on these goals:

- **Centralized repository access**: administrators register available repositories through repository configuration, and users can only create sessions in those repositories.
- **Preserved user identity boundaries**: each user uses their own GitHub or GitHub Enterprise Cloud OAuth identity and Copilot entitlement.
- **Auditable interaction flow**: sessions, messages, approval requests, event streams, and audit logs are persisted to SQLite.
- **Reduced Agent execution risk**: Copilot SDK built-in write/edit tools are disabled by default; only project-defined repository read, search, and approval-gated execution tools are exposed.
- **Concurrent multi-session support**: one user can create multiple sessions, different users can use the app concurrently, and messages inside one session are processed sequentially.

## Core Features

### Authentication And Access Control

- Supports GitHub.com OAuth and one optional GitHub Enterprise Cloud OAuth provider.
- Supports allowlist checks by organization or enterprise membership.
- Stores each user's GitHub App token encrypted.
- Uses HttpOnly cookies for browser sessions, with CSRF tokens required for mutating requests.
- Checks ownership for all session operations, so users can only access their own sessions and messages.

### Repository Selection And Context

- Administrators register trusted local repositories in `config/repositories.yaml`.
- The API returns metadata for each enabled repository, including display name, current branch, HEAD SHA, and dirty working tree status.
- The Agent can use read-only tools to inspect the repository tree, read UTF-8 text files, run text search, and inspect Git status.
- Repository path access blocks absolute paths, parent traversal, and symlinks that escape the repository root.

### Multi-Turn Chat Sessions

- Users can create, switch, rename, and delete sessions.
- Each session is bound to a repository, a model, and approval settings.
- User messages are enqueued as Turns and processed asynchronously by the Worker.
- The SSE event stream supports live Assistant deltas, tool execution status, approval requests, and Turn results.
- Message submission uses `Idempotency-Key` to avoid duplicate submission of the same turn.

### Models And Copilot Agent Integration

- The Worker starts the Copilot runtime through `@github/copilot-sdk`.
- The Copilot runtime runs in `mode: "empty"`, so SDK built-in tools are not exposed by default.
- The project exposes only custom Agent tools and explicitly rejects `builtin:*` and `mcp:*` tools.
- The Worker uses the current user's GitHub token to query available models and pass the matching Copilot identity into the session.
- Copilot SDK session state is stored in the local data directory so specific session state can be restored or deleted.

### Skill Discovery

- The project scans these skill directories in repositories:
  - `.github/skills`
  - `.agents/skills`
  - `.claude/skills`
- Each skill directory can provide a name and description through YAML frontmatter in `SKILL.md`.
- Duplicate skill names, frontmatter errors, and similar issues are returned as warnings.
- The Worker prepares a skill view for the current session and passes valid skill directories to the Copilot SDK.

### Execution Approval

The project includes three approval-gated execution capabilities:

| Scope | Tool | Description |
| --- | --- | --- |
| `shell` | `execute_shell` | Run a local shell command in the selected repository context. |
| `url` | `fetch_url` | Fetch public HTTP/HTTPS URLs through a controlled network boundary. |
| `private-script` | `run_private_script` | Run repository or private-skill scripts, including direct, shell, node, and python interpreter modes. |

Sessions support three approval modes:

- **interactive**: every execution requires user confirmation in the UI.
- **session-scoped**: only scopes listed in the session configuration are auto-approved; all others still require confirmation.
- **allow-all**: all supported execution scopes are auto-approved.

> Note: these approval modes only control whether execution may start. They are not an operating-system sandbox. Approved commands or scripts run as the same system user that started the service.

### Stop, Resume, And Delete

- Users can stop Turns that are queued or running.
- Logout attempts to stop that user's still-active sessions.
- On startup, the Worker restores Turns that were previously running or waiting for approval, requeues them, and expires unfinished approvals.
- When deleting a session, the API requires the Worker to synchronously delete the corresponding Copilot SDK state; if the Worker cannot confirm deletion, database history is not removed.

### Logging And Audit

- The API and Worker use structured logging.
- Session logs are split by user and session under `LOG_DIR/users/<userId>/sessions/<sessionId>/`.
- User input, complete Agent responses, approval decisions, lifecycle events, and related activity are recorded in the database or logs.
- SQLite stores users, GitHub accounts, Web Sessions, chat sessions, messages, Turns, permission requests, event streams, and audit logs.

## Basic Architecture

This project is a pnpm workspace organized by runtime process and shared package.

```text
Browser
  |
  v
apps/web (Next.js)
  |
  v
apps/api (Fastify HTTP API)
  |
  +--> packages/db (Prisma + SQLite)
  |
  +--> packages/repository-tools (repository config, Git info, file reads, search, skill scanning)
  |
  v
apps/worker (Copilot SDK Worker)
  |
  +--> packages/db (Turn queue, messages, events, approval state)
  |
  +--> packages/repository-tools (Agent repository tools)
  |
  +--> apps/sandbox-runner (command, URL, and private-script execution boundary)
  |
  v
GitHub Copilot SDK / local repositories / local execution environment
```

### `apps/web`: Browser UI

`apps/web` is the Next.js frontend. It handles the login entry, repository/model/session selection, chat message rendering, permission approval cards, and real-time event consumption. It calls the backend API through `apps/web/lib/api.ts` and receives session events through SSE.

Main responsibilities:

- Show the current user, available repositories, and available models.
- Create and manage chat sessions.
- Render user messages, Assistant messages, tool results, and approval requests.
- Submit approval or rejection decisions to the API.

### `apps/api`: HTTP API And Business Entry Point

`apps/api` is the Fastify service and the main boundary between the Web frontend and asynchronous backend work.

Main responsibilities:

- Handle OAuth login, callback, logout, and Web Sessions.
- Validate authentication state, CSRF tokens, session ownership, and request parameters.
- Read the repository registry and return repository metadata.
- Create, read, update, and delete chat sessions.
- Receive user messages, create Messages and Turns, and write to the event stream.
- Provide the SSE event stream with `Last-Event-ID` resume support.
- Process approval request approval or rejection.
- Call Worker control endpoints to stop or delete sessions.

### `apps/worker`: Agent Scheduling And Copilot SDK Integration

`apps/worker` is the asynchronous processing core. It polls queued Turns from the database, restores or creates a Copilot SDK session for each Turn, and persists Agent events.

Main responsibilities:

- Control processing concurrency through `WORKER_CONCURRENCY`.
- Ensure one session only processes one Turn at a time.
- Decrypt the current user's GitHub token and start the Copilot session as that user.
- Register project-defined tools for the Agent, including read-only repository tools and approval-gated execution tools.
- Write Assistant deltas, complete replies, tool start/completion events, approval requests, Turn completion/failure, and related events.
- Handle stop requests, session deletion requests, and task recovery after Worker restart.

### `apps/sandbox-runner`: Local Execution Proxy

`sandbox-runner` receives execution requests from the Worker, including shell commands, URL fetches, and private-script execution. It is a controlled entry point, not a strong isolation sandbox.

Main responsibilities:

- Start commands or scripts in the selected repository context.
- Manage session-associated execution processes and stop them by session.
- Apply basic URL-fetch limits such as protocol and response size.
- Return execution results to the Worker, which then writes messages and events.

### `packages/contracts`: Shared Types And Protocols

`packages/contracts` uses Zod to define shared frontend/backend data structures and input validation rules, such as approval modes, session state, repository summaries, messages, permission requests, and event types.

This package keeps Web, API, and Worker behavior aligned around the same business objects.

### `packages/db`: Data Access Layer

`packages/db` wraps Prisma Client and the SQLite schema. The main database models include:

- `User`: application user.
- `GitHubAccount`: the user's linked GitHub identity and encrypted token.
- `WebSession`: browser login session and CSRF token.
- `ChatSession`: chat session configuration, state, and repository snapshot.
- `Turn`: asynchronous processing task for one user prompt.
- `Message`: user, Assistant, system, and tool messages.
- `SessionEvent`: replayable SSE event stream.
- `PermissionRequest`: execution approval waiting for a user decision.
- `AuditLog`: audit records for key actions.

### `packages/repository-tools`: Repository Tooling Layer

`packages/repository-tools` manages repository configuration and safe repository access.

Main responsibilities:

- Load and watch `config/repositories.yaml`.
- Validate repository IDs, display names, absolute paths, duplicate paths, and related configuration.
- Read Git branch, HEAD SHA, and dirty status.
- Scan repository skill directories and parse `SKILL.md` frontmatter.
- Provide restricted file tree, file read, and text search capabilities.
- Block path traversal, dangerous directory reads, and symlinks that escape the repository root.

### `packages/logging`: Logging Wrapper

`packages/logging` provides unified Pino logging and supports log splitting by user, session, and service. Both the API and Worker create service loggers through this package.

## Core Data Flow

### Create A Session

1. The user selects a repository, model, and approval mode in the Web UI.
2. Web calls the API to create a session.
3. The API validates the user identity and repository configuration.
4. The API reads Git status and scans skills for the repository.
5. The API creates a `ChatSession` in SQLite and returns it to Web.

### Send A Message

1. The user sends a message in Web.
2. The API validates session ownership and `Idempotency-Key`.
3. The API creates a user `Message` and queued `Turn`.
4. The Worker polls the Turn and marks it running.
5. The Worker creates or restores the Copilot SDK session and passes repository, model, skill, and tool configuration.
6. The Agent handles the user request; deltas, tool events, and approval requests are written to `SessionEvent`.
7. Web consumes those events through SSE and updates the UI in real time.
8. When the Turn completes, the Worker stores the complete Assistant response and returns the session to idle or continues with the next queued message.

### Execution Approval

1. The Agent requests a shell, URL, or private-script tool.
2. The Worker checks whether the session approval mode allows automatic approval.
3. If manual confirmation is required, the Worker creates a `PermissionRequest` and sets the session state to `waiting-approval`.
4. Web displays an approval card.
5. After the user approves or rejects the request, the API updates approval state and writes an event.
6. The Worker continues execution or rejects the tool call.

## Directory Overview

```text
apps/
  api/              Fastify API, OAuth, auth, sessions, and event endpoints
  web/              Next.js frontend UI
  worker/           Turn scheduling, Copilot SDK integration, tool registration, and recovery
  sandbox-runner/   Local command, URL, and private-script execution proxy
packages/
  contracts/        Shared Zod schemas and TypeScript types
  db/               Prisma schema, migration scripts, and database client
  logging/          Unified logging wrapper
  repository-tools/ Repository registry, Git info, skill scanning, and read-only repository tools
config/             Repository configuration examples and local repository config
scripts/            Local development and combined startup scripts
docs/               Supplemental API, storage, and platform documentation
```

## Security Boundary

GithubCopilotWebUI is not a strong sandbox system. Although the project restricts the Agent's default tools and uses approval mechanisms for shell, URL, and private-script execution, any approved process still runs as the operating-system user that started the service. It may modify repositories, read files available to that user, start other processes, or access the network.

Only register trusted repositories, only expose the project to trusted users, and run it with a low-privilege system account. See `SECURITY.md` for more complete security guidance.
