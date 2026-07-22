# Copilot Workspace

A locally deployed, multi-user web interface for GitHub Copilot Agent. It provides ChatGPT-style conversations over administrator-configured live repositories, with per-user GitHub identity, resumable Copilot sessions, streaming responses, and controlled command, URL, and private-script execution.

## What is implemented

- GitHub.com plus one optional GitHub Enterprise Cloud OAuth provider.
- Organization allowlists and per-user encrypted GitHub App tokens.
- Multiple concurrent conversations per user with strict ownership checks.
- Create, switch, rename, and permanently delete conversations.
- Live repository reads, Git status, text search, and automatic skill discovery from `.github/skills`, `.agents/skills`, and `.claude/skills`.
- Three execution policies: Interactive, Session scoped, and Allow all.
- Sandboxed shell commands and private scripts with the repository mounted read-only.
- Controlled public URL fetching and an egress proxy for sandboxed commands.
- PostgreSQL persistence, BullMQ/Redis coordination, resumable SDK state, idempotent turns, and replayable SSE events.

## Architecture

```text
Browser -> Next.js -> Fastify API -> PostgreSQL / Redis
                                  -> BullMQ Worker -> Copilot SDK runtime
                                                  -> Sandbox Runner -> rootless container
                                                                    -> egress proxy
```

The Worker starts the bundled Copilot runtime in `mode: "empty"`. Only explicitly registered tools are visible. File writes are denied by the SDK permission handler and by the read-only repository mount.

## Prerequisites

- Docker with Compose v2; rootless Docker or Podman is strongly recommended.
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
Every configured `sandboxImage` must also appear in the comma-separated `SANDBOX_ALLOWED_IMAGES` environment variable. Only prebuilt, administrator-reviewed local images should be allowlisted.

## Run locally

```bash
cp .env.example .env
cp config/repositories.example.yaml config/repositories.yaml
```

Generate secrets:

```bash
openssl rand -base64 48  # COOKIE_SECRET
openssl rand -base64 32  # TOKEN_ENCRYPTION_KEY
openssl rand -base64 48  # SANDBOX_RUNNER_TOKEN
```

Set `REPO_ROOT`, `REPOSITORIES_CONFIG_FILE`, GitHub App credentials, and organization allowlists in `.env`, then run:

```bash
docker compose up --build
```

Open `http://localhost:3000`. API health is available at `http://localhost:4000/health/ready`.

For a rootless Docker daemon, set `CONTAINER_RUNTIME_SOCKET` to its socket, for example `/run/user/1000/docker.sock`. The Sandbox Runner is the only service that receives this socket.

## Native development

```bash
corepack pnpm install
pnpm db:generate
pnpm db:migrate:dev
pnpm dev
```

PostgreSQL and Redis must be reachable through `DATABASE_URL` and `REDIS_URL`. Native Agent turns still require a running Sandbox Runner and compatible container runtime.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

The Copilot SDK is pinned to `1.0.7`; upgrade it intentionally and rerun the compatibility build and tests.

## Important security boundary

An enabled repository should be considered entirely visible to the Agent. A private script can read any file in its repository mount and, depending on approval mode, send content to a public endpoint. Do not register a directory containing production credentials, private keys, `.env` secrets, or unrelated sensitive files. See [SECURITY.md](./SECURITY.md).
