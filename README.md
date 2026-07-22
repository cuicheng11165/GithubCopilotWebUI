# CopilotDeck

A locally deployed, multi-user web interface for GitHub Copilot Agent. It provides ChatGPT-style conversations over administrator-configured live repositories, with per-user GitHub identity, resumable Copilot sessions, streaming responses, and controlled command, URL, and private-script execution.

## What is implemented

- GitHub.com plus one optional GitHub Enterprise Cloud OAuth provider.
- Organization allowlists and per-user encrypted GitHub App tokens.
- Multiple concurrent conversations per user with strict ownership checks.
- Create, switch, rename, and permanently delete conversations.
- Live repository reads, Git status, text search, and automatic skill discovery from `.github/skills`, `.agents/skills`, and `.claude/skills`.
- Three execution policies: Interactive, Session scoped, and Allow all.
- Selectable local-process or container execution for shell commands and private scripts.
- Controlled public URL fetching and an egress proxy for sandboxed commands.
- SQLite-native local coordination or BullMQ/Redis multi-user coordination, resumable SDK state, idempotent turns, and replayable SSE events.

## Architecture

```text
Browser -> Next.js -> Fastify API -> SQLite local queue/event polling
                                  -> or PostgreSQL + Redis/BullMQ
                                  -> Worker -> Copilot SDK runtime
                                                  -> Sandbox Runner -> local host process
                                                                    -> or rootless container + egress proxy
```

The Worker starts the bundled Copilot runtime in `mode: "empty"`. Only explicitly registered tools are visible. SDK write tools are always denied. Container mode also mounts the repository read-only; local mode deliberately does not provide an operating-system isolation boundary.

## Storage modes

CopilotDeck supports two explicit deployment modes:

| Mode | Database | Intended use | Data location |
| --- | --- | --- | --- |
| `local` (default) | SQLite in WAL mode, no Redis | One machine, a personal deployment, or a small trusted team | `./data/copilot.db` and `./data/copilot/` |
| `multi-user` | PostgreSQL + Redis/BullMQ | Higher concurrency, multiple application replicas, and production operations | PostgreSQL plus the `copilot-state` volume |

Local mode stores queued turns and events in SQLite. The Worker claims queued rows, polls approval/cancellation state, and exposes a token-protected control endpoint on `127.0.0.1`. Multi-user mode keeps Redis for BullMQ, distributed locks, cancellation, and Pub/Sub. Switching modes does not automatically copy existing data; see [docs/storage.md](./docs/storage.md).

## Prerequisites

- Node.js 22 or newer and pnpm 11.
- Redis 7-compatible server is only required for `COORDINATION_BACKEND=redis` or the Compose/multi-user deployments.
- Docker with Compose v2 is optional and only needed for Compose or isolated container execution.
- PostgreSQL is only required when using `multi-user` mode; local mode stores application state in a SQLite file.
- A GitHub App on GitHub.com and, optionally, a second GitHub App on the configured GHE Cloud host.
- Copilot entitlement and Copilot CLI enabled for every user.
- One or more local repositories that do not contain production secrets.

GitHub Enterprise Server is not supported by Copilot. `GHE_HOST` must refer to GitHub Enterprise Cloud with data residency.

## GitHub App setup

Create separate GitHub Apps for GitHub.com and GHE Cloud. Configure:

- Homepage URL: `http://localhost:3000`
- Callback URL for GitHub.com: `http://localhost:3000/api/auth/github/callback`
- Callback URL for GHE: `http://localhost:3000/api/auth/ghe/callback`
- User authorization enabled.
- Organization members read permission when organization membership is enforced.
- The minimum Copilot Requests permission offered by the host.
- No repository contents permission is needed.

Install the App on each organization named in `GITHUB_ALLOWED_ORGS` or `GHE_ALLOWED_ORGS`. Enterprise slugs can instead be supplied through `GITHUB_ALLOWED_ENTERPRISES` or `GHE_ALLOWED_ENTERPRISES`; grant the App enterprise-members read access. The application fails closed when none of the configured memberships can be proven.

## Configure repositories

Copy the example and use absolute host paths:

```yaml
repositories:
  - id: platform-api
    displayName: Platform API
    path: /Users/example/code/platform-api
    enabled: true
    sandboxImage: copilot-web-sandbox:local
```

The same absolute path must be mounted at the same location inside the API, Worker, and Sandbox Runner containers. For the first repository, set `REPO_ROOT` to that path. For additional repositories, add equivalent self-bind mounts in a Compose override:

```yaml
services:
  api:
    volumes: [/another/repo:/another/repo:ro]
  worker:
    volumes: [/another/repo:/another/repo:ro]
  sandbox-runner:
    volumes: [/another/repo:/another/repo:ro]
```

Repository configuration reloads automatically. Invalid updates are rejected while the last valid registry remains active.
`sandboxImage` is ignored when `SANDBOX_BACKEND=local`. In container mode, every configured image must also appear in the comma-separated `SANDBOX_ALLOWED_IMAGES` environment variable. Only prebuilt, administrator-reviewed local images should be allowlisted.

## Run without Docker

This is the simplest single-machine deployment. Application data, queued turns, approvals, cancellation state, and replayable events use SQLite. No Redis, PostgreSQL, Docker, or Podman service is required. Shell commands/private scripts run directly as the user that started CopilotDeck.

Create the configuration:

```bash
cp .env.example .env
cp config/repositories.example.yaml config/repositories.yaml
```

Set the repository to an absolute local path, configure the GitHub App values and secrets, and keep these native settings. Native installations also need `git` and `rg` (ripgrep) on `PATH`:

```dotenv
DATABASE_MODE=local
DATABASE_URL=file:../../../data/copilot.db?connection_limit=1
COORDINATION_BACKEND=local
SANDBOX_BACKEND=local
LOCAL_SANDBOX_TMP_ROOT=./data/local-sandbox
LOCAL_WORKER_URL=http://127.0.0.1:4200
WORKER_CONTROL_PORT=4200
WORKER_CONTROL_TOKEN=replace-with-a-different-long-random-service-token
LOCAL_POLL_INTERVAL_MS=200
WORKER_CONCURRENCY=2
```

Install, migrate, and run in development mode:

```bash
corepack pnpm install
pnpm db:migrate:local
pnpm dev
```

For a production build on the same machine:

```bash
pnpm build
pnpm start:local
```

Open `http://localhost:3000`. The local starter launches Web, API, Worker, and sandbox-runner together and stops the group if one component exits. API-to-Worker control is bound to loopback and authenticated with `WORKER_CONTROL_TOKEN`. SSE and approvals normally observe SQLite changes within `LOCAL_POLL_INTERVAL_MS`.

> **No isolation in local execution mode:** approved commands and private scripts can modify the repository, read any host file available to the current user, start processes, and access the host network. Interactive and Session scoped approvals control when a process starts; they do not restrict the process after launch. Do not expose this mode to untrusted users.

### Windows native deployment

Use 64-bit Node.js 22 or newer, Git for Windows, and ripgrep from PowerShell. Windows paths may use forward slashes, which avoids `.env` and YAML escaping issues:

For complete native, Docker Desktop, service startup, backup, upgrade, and troubleshooting instructions, see the [Windows deployment guide](./docs/windows-deployment.md).

```powershell
Copy-Item .env.example .env
Copy-Item config/repositories.example.yaml config/repositories.yaml
corepack pnpm install
corepack pnpm db:migrate:local
corepack pnpm build
corepack pnpm start:local
```

For example, native `config/repositories.yaml` can contain:

```yaml
repositories:
  - id: example
    displayName: Example Repository
    path: C:/src/example
    enabled: true
```

Generate values for the four service secrets with Node, changing `48` to `32` for `TOKEN_ENCRYPTION_KEY`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64'))"
```

In Windows local mode, agent shell commands run through `cmd.exe`. Private scripts with `interpreter: shell` run through Windows PowerShell; Node and Python private scripts are launched directly without shell quoting. Stopping or timing out a command terminates its Windows process tree.

## Run with Docker Compose and SQLite

```bash
cp .env.example .env
cp config/repositories.example.yaml config/repositories.yaml
```

Generate secrets:

```bash
openssl rand -base64 48  # COOKIE_SECRET
openssl rand -base64 32  # TOKEN_ENCRYPTION_KEY
openssl rand -base64 48  # SANDBOX_RUNNER_TOKEN
openssl rand -base64 48  # WORKER_CONTROL_TOKEN (native local mode)
```

Set `REPO_ROOT`, `REPOSITORIES_CONFIG_FILE`, GitHub App credentials, and organization allowlists in `.env`, then run:

```bash
docker compose up --build
```

Open `http://localhost:3000`. API health is available at `http://localhost:4000/health/ready`.

### Windows deployment with Docker Desktop

Use Docker Desktop in Linux-container mode. Keep the repository's container path separate from its Windows host path in `.env`:

```dotenv
REPO_ROOT=/repo
REPO_HOST_PATH=C:/src/example
REPO_CONTAINER_PATH=/repo
REPOSITORIES_CONFIG_FILE=./config/repositories.yaml
```

For this Compose deployment, set the repository `path` in `config/repositories.yaml` to `/repo`. Then run `docker compose up --build` from PowerShell. Compose mounts `C:/src/example` read-only at `/repo` in the Linux API, Worker, and Sandbox Runner containers. The default `/var/run/docker.sock` setting is intended for Docker Desktop's Linux engine.

The first run creates:

```text
data/
├── copilot.db        # Users, web sessions, conversations, messages and events
├── copilot.db-shm    # SQLite runtime file
├── copilot.db-wal    # SQLite write-ahead log
└── copilot/          # Copilot SDK session state
```

The local Compose file limits Worker concurrency to two by default. Increase it only after testing the workload; SQLite still has a single writer even in WAL mode.

For a rootless Docker daemon, set `CONTAINER_RUNTIME_SOCKET` to its socket, for example `/run/user/1000/docker.sock`. The Sandbox Runner is the only service that receives this socket.

## Run in multi-user mode with PostgreSQL

Set a strong `POSTGRES_PASSWORD` in `.env`, then use the PostgreSQL Compose file:

```bash
docker compose -f compose.multi-user.yaml up --build
```

This mode preserves the PostgreSQL + Redis/BullMQ architecture and defaults to eight concurrent Worker jobs. It is the supported choice for high write concurrency or horizontal application scaling.

## Native development

```bash
corepack pnpm install
pnpm db:migrate:local
pnpm dev
```

`pnpm install` generates both Prisma clients. The default `.env.example` selects SQLite and local coordination; its relative database URL is resolved from `packages/db/prisma-sqlite`. The default `SANDBOX_BACKEND=local` does not require Redis or a container runtime.

The root `pnpm dev` command loads `.env` and normalizes repository and Copilot state paths before starting the workspace applications.

For native PostgreSQL development, set `DATABASE_MODE=multi-user`, provide a PostgreSQL `DATABASE_URL`, and run `pnpm db:migrate:multi-user`.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm db:validate
```

The Copilot SDK is pinned to `1.0.7`; upgrade it intentionally and rerun the compatibility build and tests.

## Important security boundary

An enabled repository should be considered entirely visible to the Agent. In local execution mode, an approved command can also access other files available to the host user and can modify the repository. A private script can send content to an external endpoint depending on its own behavior and the host network. Do not use local mode with untrusted users or on a machine containing production credentials, private keys, or unrelated sensitive files. See [SECURITY.md](./SECURITY.md).
