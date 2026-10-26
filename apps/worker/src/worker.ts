import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { CopilotClient, defineTool, type CopilotSession, type PermissionRequest, type PermissionRequestResult, type Tool } from "@github/copilot-sdk";
import {
  CONTINUE_PERMISSION_SCOPE,
  shouldAutoApprove,
  type ApprovalMode as ContractApprovalMode,
  type ApprovalScope
} from "@app/contracts";
import { ApprovalMode, createPrismaGitHubTokenStore, db, exchangeOAuthRefreshToken, expiredForeignLeaseWhere, MessageRole, PermissionStatus, Prisma, resolveGitHubAccessToken, SessionStatus, TurnStatus } from "@app/db";
import { createServiceLogger, rotateFileIfNeeded, rotationOptionsFromEnvironment } from "@app/logging";
import {
  RepositoryRegistry,
  globRepositoryFiles,
  getGitInfo,
  listRepositoryTree,
  readRepositoryFile,
  resolveRepositoryPath,
  scanSkills,
  searchRepository,
  viewRepositoryFile,
  type RepositoryConfig
} from "@app/repository-tools";
import { bearerAuthorizationMatches, parseEnv, serviceTokenSchema, tokenEncryptionKeySchema } from "@app/security";
import { sanitizeSdkEventForLog, sanitizeToolEventForLog } from "./tool-event-log.js";
import { lastAssistantContent } from "./assistant-response.js";
import { resolvePythonLauncher } from "./platform.js";
import { postSandboxJson } from "./sandbox-client.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { ToolRoundBudget } from "./tool-round-budget.js";
import { classifyPermissionPoll, CONTINUE_EXPIRED_MESSAGE, CONTINUE_STOPPED_MESSAGE, continueCheckpointCopy, INTERRUPTED_TURN_MESSAGE, SANDBOX_STOP_TIMEOUT_MS, sandboxRequestTimeoutMs, sdkTurnWaitMs, sessionStatusAfterInterrupt, TurnTimeoutError, waitForTurn, type TurnClock } from "./turn-control.js";
import { z } from "zod";

const booleanEnvironmentValue = z.enum(["true", "false"]).default("false").transform((value) => value === "true");
const workerEnvSchema = z.object({
  WORKER_CONTROL_HOST: z.string().default("127.0.0.1"),
  WORKER_CONTROL_PORT: z.coerce.number().int().positive().default(4200),
  WORKER_CONTROL_TOKEN: serviceTokenSchema("WORKER_CONTROL_TOKEN"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(5_000).default(200),
  TOKEN_ENCRYPTION_KEY: tokenEncryptionKeySchema(),
  REPOSITORIES_CONFIG: z.string().default("./config/repositories.yaml"),
  COPILOT_HOME: z.string().default("./data/copilot"),
  SANDBOX_RUNNER_URL: z.string().url().default("http://127.0.0.1:4100"),
  SANDBOX_RUNNER_TOKEN: serviceTokenSchema("SANDBOX_RUNNER_TOKEN"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(20),
  APPROVAL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  LLM_TRACE_ENABLED: booleanEnvironmentValue,
  LLM_TRACE_CAPTURE_CONTENT: booleanEnvironmentValue,
  LLM_TRACE_FILE: z.string().default("./data/logs/otel/copilot.jsonl"),
  TURN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(24 * 60 * 60 * 1000).default(15 * 60 * 1000),
  TURN_LEASE_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  MAX_TOOL_ROUNDS_BEFORE_CONFIRM: z.coerce.number().int().min(0).max(10_000).default(50),
  COMMAND_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  SANDBOX_REQUEST_TIMEOUT_BUFFER_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
  API_INTERNAL_URL: z.string().url().optional().or(z.literal("")),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WORKER_ID: z.string().min(1).optional().or(z.literal("")),
  GITHUB_CLIENT_ID: z.string().optional().or(z.literal("")),
  GITHUB_CLIENT_SECRET: z.string().optional().or(z.literal("")),
  GHE_CLIENT_ID: z.string().optional().or(z.literal("")),
  GHE_CLIENT_SECRET: z.string().optional().or(z.literal(""))
});
const env = parseEnv(workerEnvSchema);
const workerId = env.WORKER_ID || randomUUID();
const leaseRenewEveryMs = Math.max(1_000, Math.floor(env.TURN_LEASE_MS / 3));
const sandboxTimeoutMs = sandboxRequestTimeoutMs(env.COMMAND_TIMEOUT_SECONDS, env.SANDBOX_REQUEST_TIMEOUT_BUFFER_SECONDS);
const githubTokenStore = createPrismaGitHubTokenStore(db);
const ownedTurnIds = new Set<string>();
const logger = createServiceLogger({ service: "worker" });
const traceRotation = rotationOptionsFromEnvironment();
logger.info({ timestampFormat: "ISO 8601 UTC" }, "Worker session-routed text logging ready");
const registry = new RepositoryRegistry(env.REPOSITORIES_CONFIG);
await registry.load();
registry.watch((error) => logger.error(error, "Repository config reload failed"));
const copilotRuntimeEnv = {
  PATH: process.env.PATH ?? (process.platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/local/bin:/usr/bin:/bin"),
  HOME: env.COPILOT_HOME,
  ...(process.platform === "win32" ? {
    USERPROFILE: env.COPILOT_HOME,
    ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"
  } : {}),
  COPILOT_HOME: env.COPILOT_HOME,
  COPILOT_INTEGRATION_ID: "copilot-web-ui",
  ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
  ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
  ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {})
};
const copilotClients = new Map<string, CopilotClient>();

function copilotHostKey(host: string): string {
  return host.trim().toLowerCase() || "github.com";
}

async function getCopilotClient(host: string): Promise<CopilotClient> {
  const key = copilotHostKey(host);
  const existing = copilotClients.get(key);
  if (existing) return existing;
  const traceFile = path.resolve(env.LLM_TRACE_FILE);
  if (env.LLM_TRACE_ENABLED) {
    await mkdir(path.dirname(traceFile), { recursive: true });
    await rotateFileIfNeeded(traceFile, traceRotation);
  }
  const client = new CopilotClient({
    mode: "copilot-cli",
    baseDirectory: key === "github.com" ? env.COPILOT_HOME : path.join(env.COPILOT_HOME, "runtimes", key),
    useLoggedInUser: false,
    ...(env.LLM_TRACE_ENABLED ? {
      telemetry: {
        exporterType: "file",
        filePath: traceFile,
        captureContent: env.LLM_TRACE_CAPTURE_CONTENT,
        sourceName: "github-copilot-web-ui"
      }
    } : {}),
    env: {
      ...copilotRuntimeEnv,
      ...(key === "github.com" ? {} : { COPILOT_GH_HOST: key })
    }
  });
  await client.start();
  copilotClients.set(key, client);
  return client;
}
const activeSessions = new Map<string, { session: CopilotSession; turnId: string }>();
const stopRequested = new Set<string>();
const sessionLocks = new Set<string>();
let shuttingDown = false;

function approvalScopesFromDb(value: Prisma.JsonValue): ApprovalScope[] {
  if (!Array.isArray(value)) return [];
  return value.filter((scope): scope is ApprovalScope => scope === "shell" || scope === "url" || scope === "private-script" || scope === "mcp");
}

function decryptToken(value: string): string {
  return decryptSecret(env.TOKEN_ENCRYPTION_KEY, value);
}

function encryptToken(value: string): string {
  return encryptSecret(env.TOKEN_ENCRYPTION_KEY, value);
}

function apiBaseUrl(): string {
  if (env.API_INTERNAL_URL) return env.API_INTERNAL_URL;
  const host = env.API_HOST === "0.0.0.0" || env.API_HOST === "::" ? "127.0.0.1" : env.API_HOST;
  return `http://${host}:${env.API_PORT}`;
}

function oauthClientFor(account: { provider: string; host: string }) {
  if (account.provider === "github") {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw new Error("GitHub OAuth client is not configured");
    return { webBaseUrl: "https://github.com", clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (account.provider === "ghe") {
    if (!env.GHE_CLIENT_ID || !env.GHE_CLIENT_SECRET || !account.host) throw new Error("GitHub Enterprise OAuth client is not configured");
    return { webBaseUrl: `https://${account.host}`, clientId: env.GHE_CLIENT_ID, clientSecret: env.GHE_CLIENT_SECRET };
  }
  throw new Error("OAuth provider is no longer configured");
}

async function accessTokenForAccount(accountId: string, skewMs: number): Promise<string> {
  return resolveGitHubAccessToken({
    accountId,
    claimOwner: workerId,
    skewMs,
    store: githubTokenStore,
    decrypt: decryptToken,
    encrypt: encryptToken,
    exchange: async (refreshToken, account) => {
      const client = oauthClientFor(account);
      return exchangeOAuthRefreshToken({ ...client, refreshToken });
    }
  });
}

const pendingNotifies = new Set<string>();
let notifyTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleEventNotify(sessionId: string) {
  pendingNotifies.add(sessionId);
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    const sessionIds = [...pendingNotifies];
    pendingNotifies.clear();
    void notifySessionEvents(sessionIds);
  }, 50);
  notifyTimer.unref?.();
}

async function notifySessionEvents(sessionIds: string[]) {
  if (sessionIds.length === 0) return;
  try {
    await fetch(`${apiBaseUrl()}/internal/events/notify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WORKER_CONTROL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds }),
      signal: AbortSignal.timeout(1_000)
    });
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : "notify failed" }, "API event notify failed; polling will catch up");
  }
}

async function appendEvent(sessionId: string, turnId: string | null, kind: string, data: Record<string, unknown>) {
  await db.sessionEvent.create({ data: { sessionId, turnId, kind, data: data as Prisma.InputJsonValue } });
  scheduleEventNotify(sessionId);
}

const tracedSdkEvents = new Set([
  "system.message",
  "user.message",
  "assistant.message",
  "assistant.usage",
  "tool.execution_start",
  "tool.execution_complete",
  "model.call_failure"
]);

function traceEventData(event: { type: string; data: Record<string, unknown> }): Record<string, unknown> {
  const sanitized = sanitizeSdkEventForLog(event.data);
  if (env.LLM_TRACE_CAPTURE_CONTENT) return sanitized;
  const metadataKeys = new Set([
    "model", "apiCallId", "providerCallId", "serviceRequestId", "interactionId", "toolCallId",
    "toolName", "success", "finishReason", "duration", "inputTokens", "outputTokens",
    "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cost", "copilotUsage", "errorType",
    "statusCode", "code", "role", "name"
  ]);
  return Object.fromEntries(Object.entries(sanitized).filter(([key]) => metadataKeys.has(key)));
}

async function sandboxRequest<T>(pathname: string, body?: unknown, timeoutMs = sandboxTimeoutMs): Promise<T> {
  return postSandboxJson<T>({
    baseUrl: env.SANDBOX_RUNNER_URL,
    token: env.SANDBOX_RUNNER_TOKEN,
    pathname,
    ...(body !== undefined ? { body } : {}),
    timeoutMs
  });
}

async function prepareSkillView(sessionId: string, skills: Awaited<ReturnType<typeof scanSkills>>): Promise<string[]> {
  const selected = skills.filter((skill) => !skill.warning);
  if (selected.length === 0) return [];
  const view = path.join(env.COPILOT_HOME, "skill-views", sessionId);
  await rm(view, { recursive: true, force: true });
  await mkdir(view, { recursive: true });
  const directories: string[] = [];
  for (const [index, skill] of selected.entries()) {
    const parent = path.join(view, String(index).padStart(3, "0"));
    await mkdir(parent);
    await symlink(skill.directory, path.join(parent, path.basename(skill.directory)), process.platform === "win32" ? "junction" : "dir");
    directories.push(parent);
  }
  return directories;
}

type ManualPermissionOutcome = "approved" | "denied" | "expired" | "cancelled";

async function readPermissionPoll(permissionId: string, turnId: string) {
  const [permissionRow, turn] = await Promise.all([
    db.permissionRequest.findUnique({ where: { id: permissionId }, select: { status: true } }),
    db.turn.findUnique({ where: { id: turnId }, select: { status: true } })
  ]);
  return { permissionStatus: permissionRow?.status ?? null, turnStatus: turn?.status ?? null };
}

async function waitForManualPermission(
  sessionId: string,
  turnId: string,
  scope: string,
  intention: string,
  display: string,
  payload: Record<string, unknown>,
  resumeAfterDecision: boolean
): Promise<ManualPermissionOutcome> {
  const owned = await db.turn.findFirst({ where: { id: turnId, leaseOwner: workerId, status: { in: [TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } }, select: { id: true } });
  if (!owned) return "cancelled";
  const permission = await db.permissionRequest.create({ data: {
    sdkRequestId: randomUUID(),
    sessionId,
    turnId,
    scope,
    intention,
    display,
    payload: payload as Prisma.InputJsonValue,
    expiresAt: new Date(Date.now() + env.APPROVAL_TIMEOUT_SECONDS * 1000)
  } });
  const waiting = await db.turn.updateMany({
    where: { id: turnId, leaseOwner: workerId, status: { in: [TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } },
    data: { status: TurnStatus.WAITING_APPROVAL }
  });
  if (waiting.count === 0) {
    await db.permissionRequest.updateMany({ where: { id: permission.id, status: PermissionStatus.PENDING }, data: { status: PermissionStatus.EXPIRED, decidedAt: new Date() } });
    return "cancelled";
  }
  await db.chatSession.update({ where: { id: sessionId }, data: { status: SessionStatus.WAITING_APPROVAL } });
  await appendEvent(sessionId, turnId, "permission.requested", {
    id: permission.id,
    sessionId,
    turnId,
    scope,
    intention,
    display,
    status: "pending",
    expiresAt: permission.expiresAt.toISOString()
  });

  let snapshot = await readPermissionPoll(permission.id, turnId);
  while (Date.now() < permission.expiresAt.getTime() && classifyPermissionPoll(snapshot.permissionStatus, snapshot.turnStatus) === "pending") {
    await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
    snapshot = await readPermissionPoll(permission.id, turnId);
  }
  snapshot = await readPermissionPoll(permission.id, turnId);
  if (classifyPermissionPoll(snapshot.permissionStatus, snapshot.turnStatus) === "cancelled") {
    if (snapshot.permissionStatus === PermissionStatus.PENDING) {
      const expired = await db.permissionRequest.updateMany({
        where: { id: permission.id, status: PermissionStatus.PENDING },
        data: { status: PermissionStatus.EXPIRED, decidedAt: new Date() }
      });
      if (expired.count > 0) await appendEvent(sessionId, turnId, "permission.completed", { requestId: permission.id, decision: "expired", reason: "turn-ended" });
    }
    return "cancelled";
  }

  let outcome: ManualPermissionOutcome;
  if (snapshot.permissionStatus === PermissionStatus.APPROVED) outcome = "approved";
  else if (snapshot.permissionStatus === PermissionStatus.DENIED) outcome = "denied";
  else {
    if (snapshot.permissionStatus === PermissionStatus.PENDING) {
      await db.permissionRequest.update({ where: { id: permission.id }, data: { status: PermissionStatus.EXPIRED, decidedAt: new Date() } });
      await appendEvent(sessionId, turnId, "permission.completed", { requestId: permission.id, decision: "expired" });
    }
    outcome = "expired";
  }
  // Continue checkpoints stay in WAITING_APPROVAL when declined so the turn can be marked stopped.
  // Tool approvals resume even after a denial, because only that tool call is rejected.
  // Waiting keeps the lease renewable: renewLeases includes WAITING_APPROVAL.
  if (!(resumeAfterDecision || outcome === "approved")) return outcome;
  const resumed = await db.turn.updateMany({
    where: { id: turnId, leaseOwner: workerId, status: TurnStatus.WAITING_APPROVAL },
    data: { status: TurnStatus.RUNNING }
  });
  if (resumed.count === 0) return "cancelled";
  await db.chatSession.updateMany({ where: { id: sessionId, status: SessionStatus.WAITING_APPROVAL }, data: { status: SessionStatus.RUNNING } });
  return outcome;
}

async function waitForPermission(sessionId: string, turnId: string, scope: ApprovalScope, intention: string, display: string, payload: Record<string, unknown>): Promise<boolean> {
  const current = await db.chatSession.findUniqueOrThrow({ where: { id: sessionId } });
  const mode: ContractApprovalMode = current.approvalMode === ApprovalMode.ALLOW_ALL ? "allow-all" : current.approvalMode === ApprovalMode.SESSION_SCOPED ? "session-scoped" : "interactive";
  const autoApprove = shouldAutoApprove(mode, approvalScopesFromDb(current.approvalScopes), scope);
  if (autoApprove) {
    await db.auditLog.create({ data: { userId: current.userId, action: "permission.auto-approved", targetId: sessionId, metadata: { scope } } });
    return true;
  }
  const outcome = await waitForManualPermission(sessionId, turnId, scope, intention, display, payload, true);
  return outcome === "approved";
}

function permissionHandler(sessionId: string, turnId: string) {
  return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
    if (request.kind === "write") return { kind: "reject", feedback: "Repository writes are disabled by policy" };
    if (request.kind === "shell") {
      const approved = await waitForPermission(sessionId, turnId, "shell", request.intention, request.fullCommandText, {
        command: request.fullCommandText,
        commands: request.commands,
        possiblePaths: request.possiblePaths,
        possibleUrls: request.possibleUrls,
        hasWriteFileRedirection: request.hasWriteFileRedirection,
        warning: request.warning
      });
      return approved ? { kind: "approve-once" } : { kind: "reject", feedback: "The user denied or did not answer this shell request" };
    }
    if (request.kind === "mcp") {
      const display = `${request.serverName}: ${request.toolTitle || request.toolName}`;
      const intention = `Call MCP tool ${request.toolName} on ${request.serverName}`;
      const approved = await waitForPermission(sessionId, turnId, "mcp", intention, display, {
        serverName: request.serverName,
        toolName: request.toolName,
        toolTitle: request.toolTitle,
        readOnly: request.readOnly,
        args: request.args ?? {}
      });
      return approved ? { kind: "approve-once" } : { kind: "reject", feedback: "The user denied or did not answer this MCP request" };
    }
    if (request.kind !== "custom-tool") return { kind: "reject", feedback: `Tool permission '${request.kind}' is not available` };
    const shellTools = new Set(["bash", "apply_patch", "problems", "runTests"]);
    const scope: ApprovalScope | undefined = shellTools.has(request.toolName) ? "shell" : request.toolName === "web_fetch" ? "url" : request.toolName === "run_private_script" ? "private-script" : undefined;
    if (!scope) return { kind: "reject", feedback: "Unknown custom tool" };
    const args = request.args ?? {};
    const display = request.toolName === "bash"
      ? String(args.command ?? "")
      : request.toolName === "web_fetch"
        ? String(args.url ?? "")
        : request.toolName === "apply_patch"
          ? String(args.patch ?? "").slice(0, 8_000)
          : request.toolName === "runTests"
            ? "Run the repository test task"
            : request.toolName === "problems"
              ? "Run the repository diagnostics task"
              : String(args.script ?? "");
    const intention = typeof args.intention === "string" ? args.intention : request.toolDescription;
    const approved = await waitForPermission(sessionId, turnId, scope, intention, display, args);
    return approved ? { kind: "approve-once" } : { kind: "reject", feedback: "The user denied or did not answer this request" };
  };
}

const rawSchemas = {
  tree: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer", minimum: 0, maximum: 6 } }, additionalProperties: false },
  view: { type: "object", properties: { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, lineCount: { type: "integer", minimum: 1, maximum: 2_000 } }, required: ["path"], additionalProperties: false },
  search: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  glob: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
  shell: { type: "object", properties: { command: { type: "string" }, intention: { type: "string" } }, required: ["command", "intention"], additionalProperties: false },
  bashLookup: { type: "object", properties: { bashId: { type: "string", format: "uuid" }, tailLines: { type: "integer", minimum: 1, maximum: 5_000 } }, required: ["bashId"], additionalProperties: false },
  bashStop: { type: "object", properties: { bashId: { type: "string", format: "uuid" } }, required: ["bashId"], additionalProperties: false },
  patch: { type: "object", properties: { patch: { type: "string" }, intention: { type: "string" } }, required: ["patch", "intention"], additionalProperties: false },
  url: { type: "object", properties: { url: { type: "string", format: "uri" }, intention: { type: "string" } }, required: ["url", "intention"], additionalProperties: false },
  executionTask: { type: "object", properties: { intention: { type: "string" } }, required: ["intention"], additionalProperties: false },
  script: { type: "object", properties: { script: { type: "string" }, args: { type: "array", items: { type: "string" } }, interpreter: { type: "string", enum: ["direct", "shell", "node", "python"] }, intention: { type: "string" } }, required: ["script", "intention"], additionalProperties: false }
} as const;

async function detectRepositoryCommand(repository: RepositoryConfig, kind: "tests" | "problems"): Promise<string> {
  try {
    const packageJson = JSON.parse(await readRepositoryFile(repository, "package.json")) as {
      packageManager?: string;
      scripts?: Record<string, string>;
    };
    const script = kind === "tests"
      ? (packageJson.scripts?.test ? "test" : undefined)
      : (packageJson.scripts?.typecheck ? "typecheck" : packageJson.scripts?.lint ? "lint" : undefined);
    if (script) {
      const manager = packageJson.packageManager?.split("@")[0];
      if (manager === "pnpm") return `corepack pnpm ${script}`;
      if (manager === "yarn") return `corepack yarn ${script}`;
      if (manager === "bun") return `bun run ${script}`;
      return `npm run ${script}`;
    }
  } catch {
    // Continue with non-Node project detection.
  }
  const python = await resolvePythonLauncher().catch(() => null);
  const candidates: Array<[string, string | null]> = kind === "tests"
    ? [
        ["Cargo.toml", "cargo test"],
        ["go.mod", "go test ./..."],
        ["pyproject.toml", python ? `${python.shellPrefix} -m pytest` : null],
        ["pytest.ini", python ? `${python.shellPrefix} -m pytest` : null]
      ]
    : [
        ["Cargo.toml", "cargo check"],
        ["go.mod", "go vet ./..."],
        ["pyproject.toml", python ? `${python.shellPrefix} -m compileall -q .` : null]
      ];
  for (const [file, command] of candidates) {
    if (!command) continue;
    try {
      await readRepositoryFile(repository, file);
      return command;
    } catch {
      // Try the next supported project marker.
    }
  }
  throw new Error(`No supported repository ${kind === "tests" ? "test" : "diagnostics"} task was detected`);
}

function createTools(repository: RepositoryConfig, sessionId: string, beforeHandler?: () => Promise<void>): Tool<any>[] {
  return [
    defineTool<{ path?: string; depth?: number }>("repo_tree", {
      description: "List files and directories in the configured live repository.", parameters: rawSchemas.tree, skipPermission: true, defer: "never",
      handler: ({ path: requestedPath = ".", depth = 2 }) => listRepositoryTree(repository, requestedPath, depth)
    }),
    defineTool<{ path: string; startLine?: number; lineCount?: number }>("view", {
      description: "View a numbered line range from a UTF-8 repository file.", parameters: rawSchemas.view, skipPermission: true, defer: "never",
      handler: ({ path: requestedPath, startLine = 1, lineCount = 400 }) => viewRepositoryFile(repository, requestedPath, startLine, lineCount)
    }),
    defineTool<{ query: string }>("rg", {
      description: "Search repository text with ripgrep and return file, line, and column matches.", parameters: rawSchemas.search, skipPermission: true, defer: "never",
      handler: ({ query }) => searchRepository(repository, query)
    }),
    defineTool<{ pattern: string }>("glob", {
      description: "Find repository files matching a glob pattern.", parameters: rawSchemas.glob, skipPermission: true, defer: "never",
      handler: ({ pattern }) => globRepositoryFiles(repository, pattern)
    }),
    defineTool("repo_git_info", {
      description: "Return the current branch, HEAD SHA, and dirty state of the live repository.", parameters: { type: "object", properties: {}, additionalProperties: false }, skipPermission: true, defer: "never",
      handler: () => getGitInfo(repository)
    }),
    defineTool<{ patch: string; intention: string }>("apply_patch", {
      description: "Apply a unified git diff to files inside the live repository after validating it with git apply --check.", parameters: rawSchemas.patch, defer: "never",
      handler: ({ patch }) => sandboxRequest("/apply-patch", { repositoryId: repository.id, patch })
    }),
    defineTool<{ command: string; intention: string }>("bash", {
      description: "Start a shell command on the GithubCopilotWebUI host and return a bashId for reading or stopping it. Commands run as the host user and may modify the repository or access other resources.", parameters: rawSchemas.shell, defer: "never",
      handler: ({ command }) => sandboxRequest("/bash", { repositoryId: repository.id, sessionId, command })
    }),
    defineTool<{ bashId: string; tailLines?: number }>("read_bash", {
      description: "Read current output and status from a bash execution started in this session.", parameters: rawSchemas.bashLookup, skipPermission: true, defer: "never",
      handler: ({ bashId, tailLines }) => sandboxRequest("/bash/read", { sessionId, bashId, ...(tailLines ? { tailLines } : {}) })
    }),
    defineTool<{ bashId: string }>("stop_bash", {
      description: "Stop a bash execution started in this session.", parameters: rawSchemas.bashStop, skipPermission: true, defer: "never",
      handler: ({ bashId }) => sandboxRequest("/bash/stop", { sessionId, bashId })
    }),
    defineTool("list_bash", {
      description: "List recent bash executions and their status for this session.", parameters: { type: "object", properties: {}, additionalProperties: false }, skipPermission: true, defer: "never",
      handler: () => sandboxRequest("/bash/list", { sessionId })
    }),
    defineTool<{ intention: string }>("problems", {
      description: "Run the repository's detected typecheck, lint, or compiler diagnostics task and return a bashId.", parameters: rawSchemas.executionTask, defer: "never",
      handler: async () => sandboxRequest("/bash", { repositoryId: repository.id, sessionId, command: await detectRepositoryCommand(repository, "problems") })
    }),
    defineTool<{ intention: string }>("runTests", {
      description: "Run the repository's detected standard test task and return a bashId.", parameters: rawSchemas.executionTask, defer: "never",
      handler: async () => sandboxRequest("/bash", { repositoryId: repository.id, sessionId, command: await detectRepositoryCommand(repository, "tests") })
    }),
    defineTool<{ bashId: string; tailLines?: number }>("testFailure", {
      description: "Read the final failing-test output from a runTests bash execution.", parameters: rawSchemas.bashLookup, skipPermission: true, defer: "never",
      handler: ({ bashId, tailLines = 300 }) => sandboxRequest("/bash/read", { sessionId, bashId, tailLines })
    }),
    defineTool<{ url: string; intention: string }>("web_fetch", {
      description: "Fetch a public HTTP or HTTPS URL through the controlled network boundary.", parameters: rawSchemas.url, defer: "never",
      handler: ({ url }) => sandboxRequest("/fetch", { url, maxBytes: 1_000_000 })
    }),
    defineTool<{ script: string; args?: string[]; interpreter?: "direct" | "shell" | "node" | "python"; intention: string }>("run_private_script", {
      description: "Run a script stored in the repository or one of its private skills directly on the GithubCopilotWebUI host without isolation.", parameters: rawSchemas.script, defer: "never",
      handler: async ({ script, args = [], interpreter = "direct" }) => {
        const absolute = await resolveRepositoryPath(repository, script);
        const relative = path.relative(repository.canonicalPath, absolute);
        const python = interpreter === "python" ? await resolvePythonLauncher() : null;
        const executable = interpreter === "shell"
          ? (process.platform === "win32" ? "powershell.exe" : "/bin/sh")
          : interpreter === "node"
            ? "node"
            : interpreter === "python"
              ? python!.executable
              : absolute;
        const executableArgs = interpreter === "shell" && process.platform === "win32"
          ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", absolute, ...args]
          : interpreter === "direct"
            ? args
            : [...(python?.prefixArgs ?? []), absolute, ...args];
        return sandboxRequest("/execute", {
          repositoryId: repository.id,
          sessionId,
          command: `Run private script ${relative}`,
          executable,
          args: executableArgs
        });
      }
    })
  ].map((tool) => ({
    ...tool,
    overridesBuiltInTool: true,
    handler: async (args: any, invocation: any) => {
      if (beforeHandler) await beforeHandler();
      return tool.handler?.(args, invocation);
    }
  }));
}

interface TurnJobLike {
  data: { sessionId: string; turnId: string };
}

async function runTurn(job: TurnJobLike) {
  if (sessionLocks.has(job.data.sessionId)) {
    await db.turn.updateMany({
      where: { id: job.data.turnId, leaseOwner: workerId, status: TurnStatus.RUNNING },
      data: { status: TurnStatus.QUEUED, startedAt: null, leaseOwner: null, leaseExpiresAt: null, error: null }
    });
    return;
  }
  sessionLocks.add(job.data.sessionId);
  ownedTurnIds.add(job.data.turnId);
  let sdkSession: CopilotSession | undefined;
  let turnLogger = logger.child({ sessionId: job.data.sessionId });
  const checkpointStop: { message: string | null } = { message: null };
  let turnClock: TurnClock | undefined;
  try {
    const turn = await db.turn.findUniqueOrThrow({ where: { id: job.data.turnId }, include: { session: { include: { githubAccount: true } }, messages: { where: { role: MessageRole.USER }, orderBy: { createdAt: "asc" }, take: 1 } } });
    turnLogger = logger.child({ userId: turn.session.userId, sessionId: turn.session.id, turnId: turn.id });
    turnLogger.info("Turn processing started");
    const owned = await db.turn.updateMany({
      where: { id: turn.id, leaseOwner: workerId, status: { in: [TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } },
      data: { status: TurnStatus.RUNNING, startedAt: turn.startedAt ?? new Date(), leaseExpiresAt: new Date(Date.now() + env.TURN_LEASE_MS) }
    });
    if (owned.count === 0) return;
    if (!registry.isModelAllowed(turn.session.model)) {
      throw new Error(`Model is not allowed: ${turn.session.model}`);
    }
    const repository = registry.get(turn.session.repositoryId);
    const [git, skills] = await Promise.all([getGitInfo(repository), scanSkills(repository)]);
    await db.chatSession.update({ where: { id: turn.session.id }, data: { status: SessionStatus.RUNNING, branch: git.branch, headSha: git.headSha, dirty: git.dirty, skillManifest: skills.map(({ name, description, source, warning, contentHash }) => ({ name, description, source, warning, contentHash })) } });
    await appendEvent(turn.session.id, turn.id, "turn.started", { branch: git.branch, headSha: git.headSha, dirty: git.dirty });
    const token = await accessTokenForAccount(turn.session.githubAccount.id, Math.max(5 * 60 * 1000, env.TURN_TIMEOUT_MS));
    const client = await getCopilotClient(turn.session.githubAccount.host);
    const checkpointsEnabled = env.MAX_TOOL_ROUNDS_BEFORE_CONFIRM > 0;
    const budget = new ToolRoundBudget(env.MAX_TOOL_ROUNDS_BEFORE_CONFIRM, async (completedRounds) => {
      turnClock?.pause();
      try {
        const copy = continueCheckpointCopy(completedRounds);
        const outcome = await waitForManualPermission(turn.session.id, turn.id, CONTINUE_PERMISSION_SCOPE, copy.intention, copy.display, {
          completedRounds,
          limit: env.MAX_TOOL_ROUNDS_BEFORE_CONFIRM
        }, false);
        if (outcome === "approved") return true;
        if (!shuttingDown && (outcome === "denied" || outcome === "expired")) {
          checkpointStop.message = outcome === "denied" ? CONTINUE_STOPPED_MESSAGE : CONTINUE_EXPIRED_MESSAGE;
          stopRequested.add(turn.session.id);
        }
        return false;
      } finally {
        turnClock?.resume();
      }
    });
    const stopForCheckpoint = async () => {
      if (checkpointStop.message) stopRequested.add(turn.session.id);
      await sdkSession?.abort().catch(() => undefined);
      await sandboxRequest(`/sessions/${turn.session.id}/stop`, undefined, SANDBOX_STOP_TIMEOUT_MS).catch(() => undefined);
    };
    const beforeHandler = async () => {
      const allowed = await budget.beforeHandler();
      if (allowed) return;
      await stopForCheckpoint();
      throw new Error(checkpointStop.message ?? "The turn was stopped");
    };
    const guardTool = async () => {
      const allowed = await budget.beforeHook();
      if (allowed) return undefined;
      await stopForCheckpoint();
      return { permissionDecision: "deny" as const, permissionDecisionReason: checkpointStop.message ?? "The turn was stopped" };
    };
    const tools = checkpointsEnabled ? createTools(repository, turn.session.id, beforeHandler) : createTools(repository, turn.session.id);
    const skillDirectories = await prepareSkillView(turn.session.id, skills);
    const sessionOptions = {
      model: turn.session.model,
      gitHubToken: token,
      workingDirectory: repository.canonicalPath,
      streaming: true,
      tools,
      skillDirectories,
      disabledSkills: [],
      // Custom agents are discovered from the selected repository and chosen per session.
      enableConfigDiscovery: true,
      ...(turn.session.agent ? { agent: turn.session.agent } : {}),
      enableSkills: true,
      skipEmbeddingRetrieval: true,
      infiniteSessions: { enabled: true },
      systemMessage: { mode: "append" as const, content: "You are working with a live repository. Use view, rg, glob, and repo_tree for inspection; use apply_patch for focused edits; use problems and runTests for standard validation. Approved bash commands and private scripts run directly on the host without isolation and may modify the repository or access other host resources. Clearly report changes and validation results." },
      onPermissionRequest: permissionHandler(turn.session.id, turn.id),
      ...(checkpointsEnabled ? {
        hooks: {
          onPreToolUse: () => guardTool(),
          onPreMcpToolCall: async () => { await guardTool(); }
        }
      } : {})
    };
    const metadata = await client.getSessionMetadata(turn.session.sdkSessionId);
    sdkSession = metadata ? await client.resumeSession(turn.session.sdkSessionId, sessionOptions) : await client.createSession({ ...sessionOptions, sessionId: turn.session.sdkSessionId });
    activeSessions.set(turn.session.id, { session: sdkSession, turnId: turn.id });
    const eventOffset = (await sdkSession.getEvents()).length;
    let latestAssistantContent: string | undefined;
    sdkSession.on((rawEvent) => {
      const event = rawEvent as unknown as { type: string; data: Record<string, unknown> };
      if (env.LLM_TRACE_ENABLED && tracedSdkEvents.has(event.type)) {
        void appendEvent(turn.session.id, turn.id, "llm.trace", {
          eventType: event.type,
          capturedAt: new Date().toISOString(),
          contentCaptured: env.LLM_TRACE_CAPTURE_CONTENT,
          data: traceEventData(event)
        }).catch((error) => turnLogger.error(error, "Failed to persist LLM trace event"));
      }
      if (event.type === "assistant.message") {
        if (checkpointsEnabled) {
          const toolRequests = event.data.toolRequests;
          if (Array.isArray(toolRequests)) budget.observeToolRound(toolRequests.length);
        }
        latestAssistantContent = String(event.data.content ?? "");
        return;
      }
      void (async () => {
        if (event.type === "assistant.usage") {
          const copilotUsage = event.data.copilotUsage as { totalNanoAiu?: unknown } | undefined;
          const value = (key: string) => {
            const candidate = event.data[key];
            return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? Math.trunc(candidate) : 0;
          };
          const nanoAiu = typeof copilotUsage?.totalNanoAiu === "number" && Number.isFinite(copilotUsage.totalNanoAiu) && copilotUsage.totalNanoAiu > 0
            ? BigInt(Math.trunc(copilotUsage.totalNanoAiu))
            : 0n;
          const usage = await db.chatSession.update({
            where: { id: turn.session.id },
            data: {
              inputTokens: { increment: value("inputTokens") },
              outputTokens: { increment: value("outputTokens") },
              cacheReadTokens: { increment: value("cacheReadTokens") },
              cacheWriteTokens: { increment: value("cacheWriteTokens") },
              reasoningTokens: { increment: value("reasoningTokens") },
              nanoAiu: { increment: nanoAiu }
            },
            select: { inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, reasoningTokens: true, nanoAiu: true }
          });
          await appendEvent(turn.session.id, turn.id, "usage.updated", {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            reasoningTokens: usage.reasoningTokens,
            aiCredits: usage.nanoAiu > 0n ? Number(usage.nanoAiu) / 1_000_000_000 : null
          });
        }
        else if (event.type === "assistant.message_delta") await appendEvent(turn.session.id, turn.id, "assistant.delta", { deltaContent: String(event.data.deltaContent ?? "") });
        else if (event.type === "tool.execution_start") {
          turnLogger.info({ event: "tool.started", tool: sanitizeToolEventForLog(event.data) }, "Tool execution started");
          await appendEvent(turn.session.id, turn.id, "tool.started", event.data);
        }
        else if (event.type === "tool.execution_complete") {
          turnLogger.info({ event: "tool.completed", tool: sanitizeToolEventForLog(event.data) }, "Tool execution completed");
          const content = JSON.stringify(event.data, null, 2);
          const message = await db.message.create({ data: { sessionId: turn.session.id, turnId: turn.id, role: MessageRole.TOOL, content, metadata: { eventType: event.type } } });
          await appendEvent(turn.session.id, turn.id, "tool.completed", { ...event.data, messageId: message.id, content });
        }
        else if (event.type === "session.error") await appendEvent(turn.session.id, turn.id, "turn.failed", event.data);
      })().catch((error) => turnLogger.error(error, "Failed to persist SDK event"));
    });
    const prompt = turn.messages[0]?.content;
    if (!prompt) throw new Error("Turn has no user message");
    await waitForTurn({
      timeoutMs: env.TURN_TIMEOUT_MS,
      sdkTimeoutMs: sdkTurnWaitMs(env.TURN_TIMEOUT_MS, env.APPROVAL_TIMEOUT_SECONDS * 1000, checkpointsEnabled),
      onClock: (clock) => { turnClock = clock; },
      send: (timeoutMs) => sdkSession!.sendAndWait({ prompt }, timeoutMs),
      abort: async () => {
        await sdkSession?.abort().catch(() => undefined);
        await sandboxRequest(`/sessions/${turn.session.id}/stop`, undefined, SANDBOX_STOP_TIMEOUT_MS).catch(() => undefined);
      }
    });
    if (checkpointStop.message) {
      stopRequested.add(turn.session.id);
      throw new Error(checkpointStop.message);
    }
    const events = await sdkSession.getEvents();
    const currentTurnEvents = events.slice(eventOffset);
    const content = lastAssistantContent(currentTurnEvents as unknown as Array<{ type: string; data?: { content?: unknown } }>) ?? latestAssistantContent;
    const latestTurn = await db.turn.findUnique({ where: { id: turn.id }, select: { status: true, leaseOwner: true } });
    if (latestTurn?.status === TurnStatus.STOPPED) {
      stopRequested.add(turn.session.id);
      throw new Error("Turn was stopped");
    }
    if (latestTurn?.leaseOwner !== workerId || (latestTurn.status !== TurnStatus.RUNNING && latestTurn.status !== TurnStatus.WAITING_APPROVAL)) return;
    if (content !== undefined) {
      turnLogger.info({ event: "agent.message", content }, "Agent message completed");
      await db.message.create({ data: { sessionId: turn.session.id, turnId: turn.id, role: MessageRole.ASSISTANT, content } });
      await appendEvent(turn.session.id, turn.id, "assistant.message", { content });
      await db.sessionEvent.deleteMany({ where: { turnId: turn.id, kind: "assistant.delta" } });
    }
    const titleUpdate = turn.session.title === "New chat" ? { title: prompt.replace(/\s+/g, " ").slice(0, 60) } : {};
    const completed = await db.turn.updateMany({
      where: { id: turn.id, leaseOwner: workerId, status: { in: [TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } },
      data: { status: TurnStatus.COMPLETED, completedAt: new Date(), error: null, leaseOwner: null, leaseExpiresAt: null }
    });
    if (completed.count === 0) return;
    const nextQueued = await db.turn.findFirst({ where: { sessionId: turn.session.id, status: TurnStatus.QUEUED }, select: { id: true } });
    await db.chatSession.update({ where: { id: turn.session.id }, data: { status: nextQueued ? SessionStatus.QUEUED : SessionStatus.IDLE, ...titleUpdate } });
    await appendEvent(turn.session.id, turn.id, "turn.completed", { title: titleUpdate.title ?? turn.session.title });
    turnLogger.info("Turn processing completed");
  } catch (error) {
    const message = checkpointStop.message ?? (error instanceof Error ? error.message : "Unknown worker error");
    const timedOut = checkpointStop.message === null && error instanceof TurnTimeoutError;
    const stopped = checkpointStop.message !== null || (!timedOut && (stopRequested.has(job.data.sessionId) || message.toLowerCase().includes("abort")));
    const outcome = timedOut ? TurnStatus.TIMED_OUT : stopped ? TurnStatus.STOPPED : TurnStatus.FAILED;
    const updated = await db.turn.updateMany({
      where: { id: job.data.turnId, leaseOwner: workerId, status: { in: [TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } },
      data: { status: outcome, error: message, completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null }
    });
    if (updated.count === 0) {
      const latest = await db.turn.findUnique({ where: { id: job.data.turnId }, select: { status: true } });
      if (latest?.status === TurnStatus.STOPPED) {
        await db.chatSession.updateMany({ where: { id: job.data.sessionId, status: { in: [SessionStatus.RUNNING, SessionStatus.WAITING_APPROVAL, SessionStatus.QUEUED] } }, data: { status: SessionStatus.IDLE } });
        await appendEvent(job.data.sessionId, job.data.turnId, "turn.stopped", { error: message, ...(checkpointStop.message ? { reason: "continue-checkpoint" } : {}) });
        turnLogger.info({ error: message }, "Turn processing stopped");
      } else turnLogger.warn({ error: message, status: latest?.status }, "Turn ended after its lease was lost");
      return;
    }
    await db.chatSession.update({ where: { id: job.data.sessionId }, data: { status: stopped ? SessionStatus.IDLE : SessionStatus.ERROR } });
    const kind = timedOut ? "turn.timed_out" : stopped ? "turn.stopped" : "turn.failed";
    await appendEvent(job.data.sessionId, job.data.turnId, kind, { error: message, ...(timedOut ? { reason: "timeout" } : {}), ...(checkpointStop.message ? { reason: "continue-checkpoint" } : {}) });
    if (stopped) turnLogger.info({ error: message }, "Turn processing stopped");
    else if (timedOut) turnLogger.warn({ error: message }, "Turn processing timed out");
    else turnLogger.error(error, "Turn processing failed");
    if (!stopped) throw error;
  } finally {
    ownedTurnIds.delete(job.data.turnId);
    activeSessions.delete(job.data.sessionId);
    stopRequested.delete(job.data.sessionId);
    if (sdkSession) await sdkSession.disconnect().catch(() => undefined);
    sessionLocks.delete(job.data.sessionId);
  }
}

const deleteLocks = new Set<string>();

async function handleControl(name: string, data: Record<string, unknown>) {
  if (name === "list-models") {
    const account = await db.gitHubAccount.findUniqueOrThrow({ where: { id: String(data.githubAccountId) } });
    const token = await accessTokenForAccount(account.id, 5 * 60 * 1000);
    const host = copilotHostKey(account.host);
    const modelClient = new CopilotClient({
      mode: "copilot-cli",
      baseDirectory: path.join(env.COPILOT_HOME, "model-clients", account.id),
      gitHubToken: token,
      useLoggedInUser: false,
      env: { ...copilotRuntimeEnv, ...(host === "github.com" ? {} : { COPILOT_GH_HOST: host }) }
    });
    try {
      await modelClient.start();
      const models = await modelClient.listModels();
      return models
        .filter((model) => registry.isModelAllowed(model.id))
        .map((model) => ({ id: model.id, name: model.name ?? model.id, supportsReasoning: Boolean(model.capabilities?.supports?.reasoningEffort) }));
    } finally { await modelClient.stop(); }
  }
  const sessionId = String(data.sessionId);
  stopRequested.add(sessionId);
  const pending = await db.permissionRequest.findMany({ where: { sessionId, status: PermissionStatus.PENDING } });
  if (pending.length) await db.permissionRequest.updateMany({ where: { sessionId, status: PermissionStatus.PENDING }, data: { status: PermissionStatus.DENIED, decidedAt: new Date() } });
  const active = activeSessions.get(sessionId);
  if (active) await active.session.abort().catch(() => undefined);
  await sandboxRequest(`/sessions/${sessionId}/stop`, undefined, SANDBOX_STOP_TIMEOUT_MS).catch(() => undefined);
  if (name === "delete-session") {
    const deadline = Date.now() + 30_000;
    while (activeSessions.has(sessionId) || sessionLocks.has(sessionId)) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the active Session turn to stop");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const deleteLocked = !deleteLocks.has(sessionId);
    if (!deleteLocked) throw new Error("Session deletion is already in progress");
    deleteLocks.add(sessionId);
    try {
      const session = await db.chatSession.findUniqueOrThrow({ where: { id: sessionId }, include: { githubAccount: { select: { host: true } } } });
      const client = await getCopilotClient(session.githubAccount.host);
      await client.deleteSession(String(data.sdkSessionId)).catch((error) => {
        if (!(error instanceof Error && error.message.toLowerCase().includes("not found"))) throw error;
      });
      await rm(path.join(env.COPILOT_HOME, "skill-views", sessionId), { recursive: true, force: true });
    } finally {
      deleteLocks.delete(sessionId);
    }
  }
  if (name === "delete-session" || (name === "stop-session" && !active)) stopRequested.delete(sessionId);
  return { ok: true };
}

const executions = new Set<Promise<void>>();
let schedulerTimer: NodeJS.Timeout | undefined;
let cancellationTimer: NodeJS.Timeout | undefined;
let leaseTimer: NodeJS.Timeout | undefined;
let schedulerBusy = false;
let cancellationBusy = false;
let leaseBusy = false;
let lastRecoveryAt = 0;

async function pruneSettledDeltas() {
  await db.$executeRaw`
    DELETE FROM "SessionEvent"
    WHERE "kind" = 'assistant.delta'
      AND "turnId" IN (
        SELECT "turnId" FROM "Message"
        WHERE "role" = 'ASSISTANT' AND "turnId" IS NOT NULL
      )
  `;
}

async function recoverExpiredLeases() {
  const now = new Date();
  const candidates = await db.turn.findMany({
    where: expiredForeignLeaseWhere(workerId, now),
    select: { id: true, sessionId: true }
  });
  for (const candidate of candidates) {
    const pending = await db.permissionRequest.findMany({
      where: { turnId: candidate.id, status: PermissionStatus.PENDING },
      select: { id: true, sessionId: true, turnId: true }
    });
    const changed = await db.turn.updateMany({
      where: { AND: [{ id: candidate.id }, expiredForeignLeaseWhere(workerId, now)] },
      data: {
        status: TurnStatus.INTERRUPTED,
        error: INTERRUPTED_TURN_MESSAGE,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null
      }
    });
    if (changed.count === 0) continue;
    if (pending.length > 0) {
      await db.permissionRequest.updateMany({
        where: { id: { in: pending.map((permission) => permission.id) }, status: PermissionStatus.PENDING },
        data: { status: PermissionStatus.EXPIRED, decidedAt: now }
      });
      for (const permission of pending) {
        await appendEvent(permission.sessionId, permission.turnId, "permission.completed", { requestId: permission.id, decision: "expired", reason: "lease-expired" });
      }
    }
    const active = await db.turn.findMany({
      where: { sessionId: candidate.sessionId, status: { in: [TurnStatus.QUEUED, TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } },
      select: { status: true }
    });
    await db.chatSession.update({
      where: { id: candidate.sessionId },
      data: { status: sessionStatusAfterInterrupt(active.map((turn) => turn.status)) }
    });
    await appendEvent(candidate.sessionId, candidate.id, "turn.interrupted", { error: INTERRUPTED_TURN_MESSAGE, reason: "lease-expired" });
    logger.warn({ sessionId: candidate.sessionId, turnId: candidate.id }, "Turn interrupted after lease expiry");
  }
}

async function renewLeases() {
  if (ownedTurnIds.size === 0) return;
  const ids = [...ownedTurnIds];
  // WAITING_APPROVAL covers tool approvals and continue checkpoints, so the lease stays
  // renewed while the user is deciding and that wait is outside the turn clock.
  await db.turn.updateMany({
    where: { id: { in: ids }, leaseOwner: workerId, status: { in: [TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } },
    data: { leaseExpiresAt: new Date(Date.now() + env.TURN_LEASE_MS) }
  });
  const current = await db.turn.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, leaseOwner: true }
  });
  const lost = new Set(current.filter((turn) => (
    turn.status === TurnStatus.INTERRUPTED ||
    ((turn.status === TurnStatus.RUNNING || turn.status === TurnStatus.WAITING_APPROVAL) && turn.leaseOwner !== workerId)
  )).map((turn) => turn.id));
  for (const [sessionId, active] of activeSessions) {
    if (!lost.has(active.turnId)) continue;
    await active.session.abort().catch(() => undefined);
    await sandboxRequest(`/sessions/${sessionId}/stop`, undefined, SANDBOX_STOP_TIMEOUT_MS).catch(() => undefined);
  }
}

async function claimTurn(turn: { id: string; sessionId: string }): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "ChatSession" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${turn.sessionId}`;
    const busy = await tx.turn.findFirst({
      where: { sessionId: turn.sessionId, status: { in: [TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } },
      select: { id: true }
    });
    if (busy) return false;
    const claimed = await tx.turn.updateMany({
      where: { id: turn.id, status: TurnStatus.QUEUED },
      data: { status: TurnStatus.RUNNING, startedAt: new Date(), error: null, leaseOwner: workerId, leaseExpiresAt: new Date(Date.now() + env.TURN_LEASE_MS) }
    });
    return claimed.count === 1;
  });
}

async function pollTurns() {
  if (shuttingDown || schedulerBusy) return;
  schedulerBusy = true;
  try {
    if (Date.now() - lastRecoveryAt >= leaseRenewEveryMs) {
      lastRecoveryAt = Date.now();
      await recoverExpiredLeases();
    }
    const capacity = env.WORKER_CONCURRENCY - executions.size;
    if (capacity <= 0) return;
    const candidates = await db.turn.findMany({
      where: { status: TurnStatus.QUEUED },
      orderBy: { createdAt: "asc" },
      take: Math.max(capacity * 4, capacity),
      select: { id: true, sessionId: true }
    });
    const reservedSessions = new Set([...sessionLocks, ...activeSessions.keys()]);
    for (const turn of candidates) {
      if (executions.size >= env.WORKER_CONCURRENCY) break;
      if (reservedSessions.has(turn.sessionId)) continue;
      const claimed = await claimTurn(turn);
      if (!claimed) continue;
      reservedSessions.add(turn.sessionId);
      const execution = runTurn({ data: { sessionId: turn.sessionId, turnId: turn.id } })
        .catch(() => undefined)
        .finally(() => executions.delete(execution));
      executions.add(execution);
    }
  } finally {
    schedulerBusy = false;
  }
}

async function pollCancellations() {
  if (shuttingDown || cancellationBusy || activeSessions.size === 0) return;
  cancellationBusy = true;
  try {
    for (const [sessionId, active] of activeSessions) {
      const turn = await db.turn.findUnique({ where: { id: active.turnId }, select: { status: true } });
      if (turn?.status !== TurnStatus.STOPPED) continue;
      stopRequested.add(sessionId);
      await active.session.abort().catch(() => undefined);
      await sandboxRequest(`/sessions/${sessionId}/stop`, undefined, SANDBOX_STOP_TIMEOUT_MS).catch(() => undefined);
    }
  } finally {
    cancellationBusy = false;
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString();
    if (raw.length > 256 * 1024) throw new Error("Request body is too large");
  }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

const controlServer = createServer(async (request, response) => {
  try {
    if (request.url === "/health/ready" && request.method === "GET") return sendJson(response, 200, { status: "ready", database: "sqlite" });
    if (!bearerAuthorizationMatches(request.headers.authorization, env.WORKER_CONTROL_TOKEN)) return sendJson(response, 401, { error: "Unauthorized" });
    if (request.method !== "POST") return sendJson(response, 404, { error: "Not found" });
    const body = await readJson(request);
    if (request.url === "/models") return sendJson(response, 200, await handleControl("list-models", body));
    const match = request.url?.match(/^\/sessions\/([0-9a-f-]+)\/(stop|delete)$/i);
    if (!match) return sendJson(response, 404, { error: "Not found" });
    const name = match[2] === "delete" ? "delete-session" : "stop-session";
    return sendJson(response, 200, await handleControl(name, { ...body, sessionId: match[1] }));
  } catch (error) {
    return sendJson(response, 500, { error: error instanceof Error ? error.message : "Worker control failed" });
  }
});

await new Promise<void>((resolve, reject) => {
  controlServer.once("error", reject);
  controlServer.listen(env.WORKER_CONTROL_PORT, env.WORKER_CONTROL_HOST, resolve);
});
logger.info({ host: env.WORKER_CONTROL_HOST, port: env.WORKER_CONTROL_PORT, workerId }, "Worker control listening");
await pruneSettledDeltas();
await recoverExpiredLeases();
lastRecoveryAt = Date.now();
await pollTurns();
schedulerTimer = setInterval(() => void pollTurns().catch((error) => logger.error(error, "Worker scheduler failed")), env.WORKER_POLL_INTERVAL_MS);
cancellationTimer = setInterval(() => void pollCancellations().catch((error) => logger.error(error, "Worker cancellation poll failed")), env.WORKER_POLL_INTERVAL_MS);
leaseTimer = setInterval(() => {
  if (leaseBusy) return;
  leaseBusy = true;
  void renewLeases()
    .then(() => recoverExpiredLeases())
    .catch((error) => logger.error(error, "Worker lease renewal failed"))
    .finally(() => { leaseBusy = false; });
}, leaseRenewEveryMs);

async function shutdown() {
  shuttingDown = true;
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (cancellationTimer) clearInterval(cancellationTimer);
  if (leaseTimer) clearInterval(leaseTimer);
  if (notifyTimer) clearTimeout(notifyTimer);
  for (const [sessionId, active] of activeSessions) {
    stopRequested.add(sessionId);
    const pending = await db.permissionRequest.findMany({ where: { sessionId, status: PermissionStatus.PENDING } });
    if (pending.length) await db.permissionRequest.updateMany({ where: { sessionId, status: PermissionStatus.PENDING }, data: { status: PermissionStatus.DENIED, decidedAt: new Date() } });
    await active.session.abort().catch(() => undefined);
    await sandboxRequest(`/sessions/${sessionId}/stop`, undefined, SANDBOX_STOP_TIMEOUT_MS).catch(() => undefined);
  }
  await Promise.allSettled([...executions]);
  await new Promise<void>((resolve) => controlServer.close(() => resolve()));
  await Promise.allSettled([...copilotClients.values()].map((client) => client.stop()));
  registry.close();
  await db.$disconnect();
}
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
