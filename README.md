# GithubCopilotWebUI

GithubCopilotWebUI is a locally deployed, multi-user Web UI for GitHub Copilot Agent. It provides ChatGPT-style conversations over administrator-configured repositories, with per-user GitHub identity, multiple Sessions, streaming responses, and approved command, URL, and private-script execution.

## Features

- GitHub.com and one optional GitHub Enterprise Cloud OAuth provider.
- Organization or enterprise membership allowlists and encrypted GitHub App user tokens.
- Multiple concurrent conversations per user with strict ownership checks.
- Create, switch, rename, and permanently delete conversations.
- Live repository reads, Git status, text search, and skill discovery from `.github/skills`, `.agents/skills`, and `.claude/skills`.
- Interactive, Session scoped, and Allow all execution approval modes.
- Local shell commands, controlled public URL requests, and repository private scripts.
- SQLite-backed task coordination, resumable Copilot SDK state, idempotent turns, and replayable SSE events.

## Architecture

```text
Browser -> Next.js -> Fastify API -> SQLite
                                  -> Worker -> Copilot SDK
                                             -> Local Execution Runner
```

The Worker starts the Copilot runtime in `mode: "empty"` and exposes only the application tools. SDK write/edit tools are rejected. Approved shell commands and private scripts run directly as the operating-system user that started GithubCopilotWebUI.

GithubCopilotWebUI is designed for one installation and one Worker process on a single machine. Multiple authenticated users and concurrent Sessions are supported, but horizontal replicas and network-mounted SQLite files are not.

## Prerequisites

- Node.js 22 or newer and pnpm 11.
- `git` and `rg` (ripgrep) on `PATH`.
- A GitHub App on GitHub.com and, optionally, a second GitHub App on the configured GHE Cloud host.
- Copilot entitlement and Copilot CLI enabled for every user.
- One or more trusted local repositories.

GitHub Enterprise Server is not supported by Copilot. `GHE_HOST` must refer to GitHub Enterprise Cloud with data residency.

## GitHub App setup

Create separate GitHub Apps for GitHub.com and GHE Cloud. Configure:

- Homepage URL: `http://localhost:3000`
- GitHub.com callback: `http://localhost:3000/api/auth/github/callback`
- GHE callback: `http://localhost:3000/api/auth/ghe/callback`
- User authorization enabled.
- Organization members read permission when organization membership is enforced.
- The minimum Copilot Requests permission offered by the host.
- No repository contents permission.

Install the App on each organization named in `GITHUB_ALLOWED_ORGS` or `GHE_ALLOWED_ORGS`. Enterprise slugs can instead be supplied through `GITHUB_ALLOWED_ENTERPRISES` or `GHE_ALLOWED_ENTERPRISES`; grant the App enterprise-members read access. Authentication fails closed when configured membership cannot be verified.

## Configure repositories

Copy `config/repositories.example.yaml` to `config/repositories.yaml` and use absolute local paths:

```yaml
repositories:
  - id: platform-api
    displayName: Platform API
    path: /Users/example/code/platform-api
    enabled: true
```

Repository configuration reloads automatically. Invalid updates are rejected while the last valid configuration remains active. Registered repositories and their skills are visible to every authenticated, authorized user.

## Install and run

Create the configuration:

```bash
cp .env.example .env
cp config/repositories.example.yaml config/repositories.yaml
```

Set the GitHub App values, generate independent service secrets, and configure each repository with an absolute path. The important local settings are:

```dotenv
DATABASE_URL=file:../../../data/copilot.db?connection_limit=1
LOG_LEVEL=info
LOG_DIR=./data/logs
LOCAL_SANDBOX_TMP_ROOT=./data/local-sandbox
WORKER_CONTROL_URL=http://127.0.0.1:4200
WORKER_CONTROL_HOST=127.0.0.1
WORKER_CONTROL_PORT=4200
WORKER_CONTROL_TOKEN=replace-with-a-different-long-random-service-token
WORKER_POLL_INTERVAL_MS=200
EVENT_POLL_INTERVAL_MS=200
WORKER_CONCURRENCY=2
```

API and Worker session logs are written as JSON text lines to
`LOG_DIR/users/<userId>/sessions/<sessionId>/api.log` and `worker.log` while
continuing to appear in the console. Startup and other logs without a session
context are written under the user's `system` folder, or under `LOG_DIR/system`
when no user is known. `LOG_LEVEL` controls the minimum level. Relative
`LOG_DIR` values are resolved from the repository root.

Each session's API log includes complete user inputs as `user.message` events,
and its Worker log includes complete Agent responses as `agent.message` events.
Streaming response fragments are not logged separately. Log timestamps use the
ISO 8601 UTC format (for example, `2026-07-23T05:30:12.345Z`).

Development:

```bash
corepack pnpm install
pnpm db:migrate
pnpm dev
```

Production on the same machine:

```bash
pnpm build
pnpm start:local
```

Open `http://localhost:3000`. The production starter launches Web, API, Worker, and Local Execution Runner together and stops the whole group if one component exits. Internal control endpoints bind to loopback and require independent bearer tokens.

### macOS

Use Node.js 22 or newer with Git and ripgrep installed through Homebrew. Apple Silicon installations should use arm64-native Node.js and avoid sharing `node_modules` with Rosetta terminals. For production startup, explicit `launchd` PATH configuration, macOS privacy permissions, backups, HTTPS proxying, and troubleshooting, see the [macOS deployment guide](./docs/macos-deployment.md).

### Windows

Use 64-bit Node.js 22 or newer, Git for Windows, and ripgrep from PowerShell. Repository paths may use forward slashes:

```yaml
repositories:
  - id: example
    displayName: Example Repository
    path: C:/src/example
    enabled: true
```

Shell commands use `cmd.exe`. Private scripts marked `interpreter: shell` use Windows PowerShell; Node and Python scripts use their native interpreters. See the [Windows deployment guide](./docs/windows-deployment.md).

## Storage

SQLite stores users, encrypted tokens, Web Sessions, conversations, queued turns, approvals, events, and audit logs. Copilot SDK state is under `data/copilot/`; temporary execution homes are under `data/local-sandbox/`. See [docs/storage.md](./docs/storage.md) for backup and recovery.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm db:validate
```

The Copilot SDK is pinned to `1.0.7`; upgrade it intentionally and rerun the compatibility build and tests.

## Security warning

There is no operating-system isolation boundary. Approved commands and private scripts can modify the selected repository, read any file available to the GithubCopilotWebUI process, start other processes, and use the host network. Approval modes control whether execution may begin; they cannot constrain a process after it starts.

Run GithubCopilotWebUI with a dedicated low-privilege account, register only trusted repositories, keep internal ports on loopback, and do not expose the application to untrusted users. See [SECURITY.md](./SECURITY.md).
