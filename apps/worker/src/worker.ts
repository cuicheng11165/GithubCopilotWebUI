import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { mkdir, rm, symlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { CopilotClient, defineTool, type CopilotSession, type PermissionRequest, type PermissionRequestResult, type Tool } from "@github/copilot-sdk";
import {
  shouldAutoApprove,
  type ApprovalMode as ContractApprovalMode,
  type ApprovalScope
} from "@app/contracts";
import { ApprovalMode, MessageRole, PermissionStatus, Prisma, SessionStatus, TurnStatus, db } from "@app/db";
import {
  RepositoryRegistry,
  getGitInfo,
  listRepositoryTree,
  readRepositoryFile,
  resolveRepositoryPath,
  scanSkills,
  searchRepository,
  type RepositoryConfig
} from "@app/repository-tools";
import { z } from "zod";

const env = z.object({
  WORKER_CONTROL_HOST: z.string().default("127.0.0.1"),
  WORKER_CONTROL_PORT: z.coerce.number().int().positive().default(4200),
  WORKER_CONTROL_TOKEN: z.string().min(32),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(5_000).default(200),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  REPOSITORIES_CONFIG: z.string().default("./config/repositories.yaml"),
  COPILOT_HOME: z.string().default("./data/copilot"),
  SANDBOX_RUNNER_URL: z.string().url().default("http://127.0.0.1:4100"),
  SANDBOX_RUNNER_TOKEN: z.string().min(32),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(8),
  APPROVAL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300)
}).parse(process.env);
const registry = new RepositoryRegistry(env.REPOSITORIES_CONFIG);
await registry.load();
registry.watch((error) => console.error("Repository config reload failed", error));
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
  const client = new CopilotClient({
    mode: "empty",
    baseDirectory: key === "github.com" ? env.COPILOT_HOME : path.join(env.COPILOT_HOME, "runtimes", key),
    useLoggedInUser: false,
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
  return value.filter((scope): scope is ApprovalScope => scope === "shell" || scope === "url" || scope === "private-script");
}

function decryptToken(value: string): string {
  const [version, iv, tag, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Unsupported encrypted token format");
  const raw = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");
  const key = raw.length === 32 ? raw : createHash("sha256").update(env.TOKEN_ENCRYPTION_KEY).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

async function appendEvent(sessionId: string, turnId: string | null, kind: string, data: Record<string, unknown>) {
  await db.sessionEvent.create({ data: { sessionId, turnId, kind, data: data as Prisma.InputJsonValue } });
}

async function sandboxRequest<T>(pathname: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SANDBOX_RUNNER_TOKEN}`, "Content-Type": "application/json" }
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${env.SANDBOX_RUNNER_URL}${pathname}`, init);
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Sandbox runner returned ${response.status}`);
  return result;
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

async function waitForPermission(sessionId: string, turnId: string, scope: ApprovalScope, intention: string, display: string, payload: Record<string, unknown>): Promise<boolean> {
  const current = await db.chatSession.findUniqueOrThrow({ where: { id: sessionId } });
  const mode: ContractApprovalMode = current.approvalMode === ApprovalMode.ALLOW_ALL ? "allow-all" : current.approvalMode === ApprovalMode.SESSION_SCOPED ? "session-scoped" : "interactive";
  const autoApprove = shouldAutoApprove(mode, approvalScopesFromDb(current.approvalScopes), scope);
  if (autoApprove) {
    await db.auditLog.create({ data: { userId: current.userId, action: "permission.auto-approved", targetId: sessionId, metadata: { scope } } });
    return true;
  }

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
  await db.$transaction([
    db.chatSession.update({ where: { id: sessionId }, data: { status: SessionStatus.WAITING_APPROVAL } }),
    db.turn.update({ where: { id: turnId }, data: { status: TurnStatus.WAITING_APPROVAL } })
  ]);
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

  let approved = false;
  while (Date.now() < permission.expiresAt.getTime()) {
    const [latestPermission, latestTurn] = await Promise.all([
      db.permissionRequest.findUnique({ where: { id: permission.id }, select: { status: true } }),
      db.turn.findUnique({ where: { id: turnId }, select: { status: true } })
    ]);
    if (!latestPermission || latestPermission.status !== PermissionStatus.PENDING) {
      approved = latestPermission?.status === PermissionStatus.APPROVED;
      break;
    }
    if (!latestTurn || latestTurn.status === TurnStatus.STOPPED) break;
    await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
  }
  const latest = await db.permissionRequest.findUnique({ where: { id: permission.id } });
  if (latest?.status === PermissionStatus.APPROVED) approved = true;
  if (latest?.status === PermissionStatus.PENDING) {
    await db.permissionRequest.update({ where: { id: permission.id }, data: { status: PermissionStatus.EXPIRED, decidedAt: new Date() } });
    await appendEvent(sessionId, turnId, "permission.completed", { requestId: permission.id, decision: "expired" });
  }
  const latestTurn = await db.turn.findUnique({ where: { id: turnId }, select: { status: true } });
  if (!latestTurn || latestTurn.status === TurnStatus.STOPPED) return false;
  await db.$transaction([
    db.chatSession.update({ where: { id: sessionId }, data: { status: SessionStatus.RUNNING } }),
    db.turn.update({ where: { id: turnId }, data: { status: TurnStatus.RUNNING } })
  ]);
  return approved;
}

function permissionHandler(sessionId: string, turnId: string) {
  return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
    if (request.kind === "write") return { kind: "reject", feedback: "Repository writes are disabled by policy" };
    if (request.kind !== "custom-tool") return { kind: "reject", feedback: `Tool permission '${request.kind}' is not available` };
    const scope: ApprovalScope | undefined = request.toolName === "execute_shell" ? "shell" : request.toolName === "fetch_url" ? "url" : request.toolName === "run_private_script" ? "private-script" : undefined;
    if (!scope) return { kind: "reject", feedback: "Unknown custom tool" };
    const args = request.args ?? {};
    const display = request.toolName === "execute_shell" ? String(args.command ?? "") : request.toolName === "fetch_url" ? String(args.url ?? "") : String(args.script ?? "");
    const intention = typeof args.intention === "string" ? args.intention : request.toolDescription;
    const approved = await waitForPermission(sessionId, turnId, scope, intention, display, args);
    return approved ? { kind: "approve-once" } : { kind: "reject", feedback: "The user denied or did not answer this request" };
  };
}

const rawSchemas = {
  tree: { type: "object", properties: { path: { type: "string" }, depth: { type: "integer", minimum: 0, maximum: 6 } }, additionalProperties: false },
  read: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  search: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  shell: { type: "object", properties: { command: { type: "string" }, intention: { type: "string" } }, required: ["command", "intention"], additionalProperties: false },
  url: { type: "object", properties: { url: { type: "string", format: "uri" }, intention: { type: "string" } }, required: ["url", "intention"], additionalProperties: false },
  script: { type: "object", properties: { script: { type: "string" }, args: { type: "array", items: { type: "string" } }, interpreter: { type: "string", enum: ["direct", "shell", "node", "python"] }, intention: { type: "string" } }, required: ["script", "intention"], additionalProperties: false }
} as const;

function createTools(repository: RepositoryConfig, sessionId: string): Tool<any>[] {
  return [
    defineTool<{ path?: string; depth?: number }>("repo_tree", {
      description: "List files and directories in the configured live repository.", parameters: rawSchemas.tree, skipPermission: true, defer: "never",
      handler: ({ path: requestedPath = ".", depth = 2 }) => listRepositoryTree(repository, requestedPath, depth)
    }),
    defineTool<{ path: string }>("repo_read_file", {
      description: "Read a UTF-8 text file from the configured live repository.", parameters: rawSchemas.read, skipPermission: true, defer: "never",
      handler: ({ path: requestedPath }) => readRepositoryFile(repository, requestedPath)
    }),
    defineTool<{ query: string }>("repo_search", {
      description: "Search text in the configured live repository and return file/line matches.", parameters: rawSchemas.search, skipPermission: true, defer: "never",
      handler: ({ query }) => searchRepository(repository, query)
    }),
    defineTool("repo_git_info", {
      description: "Return the current branch, HEAD SHA, and dirty state of the live repository.", parameters: { type: "object", properties: {}, additionalProperties: false }, skipPermission: true, defer: "never",
      handler: () => getGitInfo(repository)
    }),
    defineTool<{ command: string; intention: string }>("execute_shell", {
      description: "Execute a shell command directly on the CopilotDeck host as its current operating-system user. The command can modify the repository and access other host resources.", parameters: rawSchemas.shell, defer: "never",
      handler: ({ command }) => sandboxRequest("/execute", { repositoryId: repository.id, sessionId, command })
    }),
    defineTool<{ url: string; intention: string }>("fetch_url", {
      description: "Fetch a public HTTP or HTTPS URL through the controlled network boundary.", parameters: rawSchemas.url, defer: "never",
      handler: ({ url }) => sandboxRequest("/fetch", { url, maxBytes: 1_000_000 })
    }),
    defineTool<{ script: string; args?: string[]; interpreter?: "direct" | "shell" | "node" | "python"; intention: string }>("run_private_script", {
      description: "Run a script stored in the repository or one of its private skills directly on the CopilotDeck host without isolation.", parameters: rawSchemas.script, defer: "never",
      handler: async ({ script, args = [], interpreter = "direct" }) => {
        const absolute = await resolveRepositoryPath(repository, script);
        const relative = path.relative(repository.canonicalPath, absolute);
        const executable = interpreter === "shell"
          ? (process.platform === "win32" ? "powershell.exe" : "/bin/sh")
          : interpreter === "node"
            ? "node"
            : interpreter === "python"
              ? (process.platform === "win32" ? "python" : "python3")
              : absolute;
        const executableArgs = interpreter === "shell" && process.platform === "win32"
          ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", absolute, ...args]
          : interpreter === "direct"
            ? args
            : [absolute, ...args];
        return sandboxRequest("/execute", {
          repositoryId: repository.id,
          sessionId,
          command: `Run private script ${relative}`,
          executable,
          args: executableArgs
        });
      }
    })
  ];
}

interface TurnJobLike {
  data: { sessionId: string; turnId: string };
}

async function runTurn(job: TurnJobLike) {
  const locked = !sessionLocks.has(job.data.sessionId);
  if (!locked) throw new Error("Session is already processing another turn");
  sessionLocks.add(job.data.sessionId);
  let sdkSession: CopilotSession | undefined;
  try {
    const turn = await db.turn.findUniqueOrThrow({ where: { id: job.data.turnId }, include: { session: { include: { githubAccount: true } }, messages: { where: { role: MessageRole.USER }, orderBy: { createdAt: "asc" }, take: 1 } } });
    if (turn.status === TurnStatus.STOPPED) return;
    const repository = registry.get(turn.session.repositoryId);
    const [git, skills] = await Promise.all([getGitInfo(repository), scanSkills(repository)]);
    await db.$transaction([
      db.turn.update({ where: { id: turn.id }, data: { status: TurnStatus.RUNNING, startedAt: new Date() } }),
      db.chatSession.update({ where: { id: turn.session.id }, data: { status: SessionStatus.RUNNING, branch: git.branch, headSha: git.headSha, dirty: git.dirty, skillManifest: skills.map(({ name, description, source, warning, contentHash }) => ({ name, description, source, warning, contentHash })) } })
    ]);
    await appendEvent(turn.session.id, turn.id, "turn.started", { branch: git.branch, headSha: git.headSha, dirty: git.dirty });
    const token = decryptToken(turn.session.githubAccount.encryptedAccessToken);
    const client = await getCopilotClient(turn.session.githubAccount.host);
    const tools = createTools(repository, turn.session.id);
    const skillDirectories = await prepareSkillView(turn.session.id, skills);
    const sessionOptions = {
      model: turn.session.model,
      gitHubToken: token,
      workingDirectory: repository.canonicalPath,
      streaming: true,
      tools,
      availableTools: tools.map((tool) => `custom:${tool.name}`),
      excludedTools: ["builtin:*", "mcp:*"],
      skillDirectories,
      disabledSkills: [],
      enableConfigDiscovery: false,
      enableSkills: true,
      skipEmbeddingRetrieval: true,
      infiniteSessions: { enabled: true },
      systemMessage: { mode: "append" as const, content: "You are working with a live repository. SDK write/edit tools are disabled, but approved shell commands and private scripts run directly on the host without isolation and may modify the repository or access other host resources. Use repository tools for reading and clearly report any command that changes files." },
      onPermissionRequest: permissionHandler(turn.session.id, turn.id)
    };
    const metadata = await client.getSessionMetadata(turn.session.sdkSessionId);
    sdkSession = metadata ? await client.resumeSession(turn.session.sdkSessionId, sessionOptions) : await client.createSession({ ...sessionOptions, sessionId: turn.session.sdkSessionId });
    activeSessions.set(turn.session.id, { session: sdkSession, turnId: turn.id });
    let assistantSaved = false;
    sdkSession.on((rawEvent) => {
      const event = rawEvent as unknown as { type: string; data: Record<string, unknown> };
      void (async () => {
        if (event.type === "assistant.message_delta") await appendEvent(turn.session.id, turn.id, "assistant.delta", { deltaContent: String(event.data.deltaContent ?? "") });
        else if (event.type === "assistant.message" && !assistantSaved) {
          assistantSaved = true;
          const content = String(event.data.content ?? "");
          await db.message.create({ data: { sessionId: turn.session.id, turnId: turn.id, role: MessageRole.ASSISTANT, content } });
          await appendEvent(turn.session.id, turn.id, "assistant.message", { content });
        } else if (event.type === "tool.execution_start") await appendEvent(turn.session.id, turn.id, "tool.started", event.data);
        else if (event.type === "tool.execution_complete") {
          const content = JSON.stringify(event.data, null, 2);
          const message = await db.message.create({ data: { sessionId: turn.session.id, turnId: turn.id, role: MessageRole.TOOL, content, metadata: { eventType: event.type } } });
          await appendEvent(turn.session.id, turn.id, "tool.completed", { ...event.data, messageId: message.id, content });
        }
        else if (event.type === "session.error") await appendEvent(turn.session.id, turn.id, "turn.failed", event.data);
      })().catch((error) => console.error("Failed to persist SDK event", error));
    });
    const prompt = turn.messages[0]?.content;
    if (!prompt) throw new Error("Turn has no user message");
    await sdkSession.sendAndWait({ prompt }, 15 * 60 * 1000);
    if (!assistantSaved) {
      const events = await sdkSession.getEvents();
      const final = [...events].reverse().find((event) => event.type === "assistant.message") as unknown as { data?: { content?: string } } | undefined;
      if (final?.data?.content) {
        await db.message.create({ data: { sessionId: turn.session.id, turnId: turn.id, role: MessageRole.ASSISTANT, content: final.data.content } });
        await appendEvent(turn.session.id, turn.id, "assistant.message", { content: final.data.content });
      }
    }
    const latestTurn = await db.turn.findUnique({ where: { id: turn.id }, select: { status: true } });
    if (latestTurn?.status === TurnStatus.STOPPED) {
      stopRequested.add(turn.session.id);
      throw new Error("Turn was stopped");
    }
    const titleUpdate = turn.session.title === "New chat" ? { title: prompt.replace(/\s+/g, " ").slice(0, 60) } : {};
    const nextQueued = await db.turn.findFirst({ where: { sessionId: turn.session.id, status: TurnStatus.QUEUED }, select: { id: true } });
    await db.$transaction([
      db.turn.update({ where: { id: turn.id }, data: { status: TurnStatus.COMPLETED, completedAt: new Date() } }),
      db.chatSession.update({ where: { id: turn.session.id }, data: { status: nextQueued ? SessionStatus.QUEUED : SessionStatus.IDLE, ...titleUpdate } })
    ]);
    await appendEvent(turn.session.id, turn.id, "turn.completed", { title: titleUpdate.title ?? turn.session.title });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error";
    const stopped = stopRequested.has(job.data.sessionId) || message.toLowerCase().includes("abort");
    await db.$transaction([
      db.turn.update({ where: { id: job.data.turnId }, data: { status: stopped ? TurnStatus.STOPPED : TurnStatus.FAILED, error: message, completedAt: new Date() } }),
      db.chatSession.update({ where: { id: job.data.sessionId }, data: { status: stopped ? SessionStatus.IDLE : SessionStatus.ERROR } })
    ]);
    await appendEvent(job.data.sessionId, job.data.turnId, stopped ? "turn.stopped" : "turn.failed", { error: message });
    if (!stopped) throw error;
  } finally {
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
    const token = decryptToken(account.encryptedAccessToken);
    const host = copilotHostKey(account.host);
    const modelClient = new CopilotClient({
      mode: "empty",
      baseDirectory: path.join(env.COPILOT_HOME, "model-clients", account.id),
      gitHubToken: token,
      useLoggedInUser: false,
      env: { ...copilotRuntimeEnv, ...(host === "github.com" ? {} : { COPILOT_GH_HOST: host }) }
    });
    try {
      await modelClient.start();
      const models = await modelClient.listModels();
      return [{ id: "auto", name: "Auto", supportsReasoning: false }, ...models.map((model) => ({ id: model.id, name: model.name ?? model.id, supportsReasoning: Boolean(model.capabilities?.supports?.reasoningEffort) }))];
    } finally { await modelClient.stop(); }
  }
  const sessionId = String(data.sessionId);
  stopRequested.add(sessionId);
  const pending = await db.permissionRequest.findMany({ where: { sessionId, status: PermissionStatus.PENDING } });
  if (pending.length) await db.permissionRequest.updateMany({ where: { sessionId, status: PermissionStatus.PENDING }, data: { status: PermissionStatus.DENIED, decidedAt: new Date() } });
  const active = activeSessions.get(sessionId);
  if (active) await active.session.abort().catch(() => undefined);
  await sandboxRequest(`/sessions/${sessionId}/stop`).catch(() => undefined);
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
let schedulerBusy = false;
let cancellationBusy = false;

async function recoverWork() {
  const interrupted = await db.turn.findMany({
    where: { status: { in: [TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } },
    select: { id: true, sessionId: true }
  });
  if (interrupted.length === 0) return;
  const turnIds = interrupted.map((turn) => turn.id);
  const sessionIds = [...new Set(interrupted.map((turn) => turn.sessionId))];
  const pending = await db.permissionRequest.findMany({ where: { turnId: { in: turnIds }, status: PermissionStatus.PENDING } });
  await db.$transaction([
    db.permissionRequest.updateMany({ where: { turnId: { in: turnIds }, status: PermissionStatus.PENDING }, data: { status: PermissionStatus.EXPIRED, decidedAt: new Date() } }),
    db.turn.updateMany({ where: { id: { in: turnIds } }, data: { status: TurnStatus.QUEUED, startedAt: null, completedAt: null, error: "Recovered after Worker restart" } }),
    db.chatSession.updateMany({ where: { id: { in: sessionIds } }, data: { status: SessionStatus.QUEUED } })
  ]);
  for (const permission of pending) await appendEvent(permission.sessionId, permission.turnId, "permission.completed", { requestId: permission.id, decision: "expired", reason: "worker-restart" });
  for (const turn of interrupted) await appendEvent(turn.sessionId, turn.id, "turn.queued", { turnId: turn.id, reason: "worker-restart" });
}

async function pollTurns() {
  if (shuttingDown || schedulerBusy) return;
  schedulerBusy = true;
  try {
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
      const claimed = await db.turn.updateMany({
        where: { id: turn.id, status: TurnStatus.QUEUED },
        data: { status: TurnStatus.RUNNING, startedAt: new Date(), error: null }
      });
      if (claimed.count === 0) continue;
      reservedSessions.add(turn.sessionId);
      const execution = runTurn({ data: { sessionId: turn.sessionId, turnId: turn.id } })
        .catch((error) => console.error("Turn failed", error))
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
      await sandboxRequest(`/sessions/${sessionId}/stop`).catch(() => undefined);
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
    if (request.headers.authorization !== `Bearer ${env.WORKER_CONTROL_TOKEN}`) return sendJson(response, 401, { error: "Unauthorized" });
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
console.log(`Worker control listening on http://${env.WORKER_CONTROL_HOST}:${env.WORKER_CONTROL_PORT}`);
await recoverWork();
await pollTurns();
schedulerTimer = setInterval(() => void pollTurns().catch((error) => console.error("Worker scheduler failed", error)), env.WORKER_POLL_INTERVAL_MS);
cancellationTimer = setInterval(() => void pollCancellations().catch((error) => console.error("Worker cancellation poll failed", error)), env.WORKER_POLL_INTERVAL_MS);

async function shutdown() {
  shuttingDown = true;
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (cancellationTimer) clearInterval(cancellationTimer);
  for (const [sessionId, active] of activeSessions) {
    stopRequested.add(sessionId);
    const pending = await db.permissionRequest.findMany({ where: { sessionId, status: PermissionStatus.PENDING } });
    if (pending.length) await db.permissionRequest.updateMany({ where: { sessionId, status: PermissionStatus.PENDING }, data: { status: PermissionStatus.DENIED, decidedAt: new Date() } });
    await active.session.abort().catch(() => undefined);
    await sandboxRequest(`/sessions/${sessionId}/stop`).catch(() => undefined);
  }
  await Promise.allSettled([...executions]);
  await new Promise<void>((resolve) => controlServer.close(() => resolve()));
  await Promise.allSettled([...copilotClients.values()].map((client) => client.stop()));
  registry.close();
  await db.$disconnect();
}
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
