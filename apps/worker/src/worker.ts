import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { CopilotClient, defineTool, type CopilotSession, type PermissionRequest, type PermissionRequestResult, type Tool } from "@github/copilot-sdk";
import {
  COPILOT_CONTROL_QUEUE,
  COPILOT_TURN_QUEUE,
  PERMISSION_DECISION_CHANNEL_PREFIX,
  SESSION_EVENT_CHANNEL_PREFIX,
  STOP_CHANNEL_PREFIX,
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
  REDIS_URL: z.string().default("redis://localhost:6379"),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  REPOSITORIES_CONFIG: z.string().default("./config/repositories.yaml"),
  COPILOT_HOME: z.string().default("./data/copilot"),
  SANDBOX_RUNNER_URL: z.string().url().default("http://localhost:4100"),
  SANDBOX_RUNNER_TOKEN: z.string().min(32),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(8),
  APPROVAL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300)
}).parse(process.env);

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const queueUrl = new URL(env.REDIS_URL);
const queueConnection = {
  host: queueUrl.hostname,
  port: Number(queueUrl.port || 6379),
  ...(queueUrl.username ? { username: decodeURIComponent(queueUrl.username) } : {}),
  ...(queueUrl.password ? { password: decodeURIComponent(queueUrl.password) } : {}),
  ...(queueUrl.protocol === "rediss:" ? { tls: {} } : {})
};
const registry = new RepositoryRegistry(env.REPOSITORIES_CONFIG);
await registry.load();
registry.watch((error) => console.error("Repository config reload failed", error));
const copilotRuntimeEnv = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: env.COPILOT_HOME,
  COPILOT_HOME: env.COPILOT_HOME,
  COPILOT_INTEGRATION_ID: "copilot-web-ui",
  ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
  ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
  ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {})
};
const client = new CopilotClient({
  mode: "empty",
  baseDirectory: env.COPILOT_HOME,
  useLoggedInUser: false,
  env: copilotRuntimeEnv
});
await client.start();
const activeSessions = new Map<string, CopilotSession>();
const stopRequested = new Set<string>();

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
  const event = await db.sessionEvent.create({ data: { sessionId, turnId, kind, data: data as Prisma.InputJsonValue } });
  const serialized = { cursor: Number(event.cursor), sessionId, turnId, kind, data, createdAt: event.createdAt.toISOString() };
  await redis.publish(`${SESSION_EVENT_CHANNEL_PREFIX}${sessionId}`, JSON.stringify(serialized));
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

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
    await symlink(skill.directory, path.join(parent, path.basename(skill.directory)), "dir");
    directories.push(parent);
  }
  return directories;
}

async function waitForPermission(sessionId: string, turnId: string, scope: ApprovalScope, intention: string, display: string, payload: Record<string, unknown>): Promise<boolean> {
  const current = await db.chatSession.findUniqueOrThrow({ where: { id: sessionId } });
  const mode: ContractApprovalMode = current.approvalMode === ApprovalMode.ALLOW_ALL ? "allow-all" : current.approvalMode === ApprovalMode.SESSION_SCOPED ? "session-scoped" : "interactive";
  const autoApprove = shouldAutoApprove(mode, current.approvalScopes as ApprovalScope[], scope);
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
  const decisionSubscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const channel = `${PERMISSION_DECISION_CHANNEL_PREFIX}${permission.id}`;
  await decisionSubscriber.subscribe(channel);
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

  const approved = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), env.APPROVAL_TIMEOUT_SECONDS * 1000);
    decisionSubscriber.on("message", (incoming: string, decision: string) => {
      if (incoming !== channel) return;
      clearTimeout(timer);
      resolve(decision === "approve-once");
    });
  });
  await decisionSubscriber.quit();
  const latest = await db.permissionRequest.findUnique({ where: { id: permission.id } });
  if (latest?.status === PermissionStatus.PENDING) {
    await db.permissionRequest.update({ where: { id: permission.id }, data: { status: PermissionStatus.EXPIRED, decidedAt: new Date() } });
    await appendEvent(sessionId, turnId, "permission.completed", { requestId: permission.id, decision: "expired" });
  }
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
      description: "Execute a shell command in an isolated container with the repository mounted read-only.", parameters: rawSchemas.shell, defer: "never",
      handler: ({ command }) => sandboxRequest("/execute", { repositoryId: repository.id, sessionId, command })
    }),
    defineTool<{ url: string; intention: string }>("fetch_url", {
      description: "Fetch a public HTTP or HTTPS URL through the controlled network boundary.", parameters: rawSchemas.url, defer: "never",
      handler: ({ url }) => sandboxRequest("/fetch", { url, maxBytes: 1_000_000 })
    }),
    defineTool<{ script: string; args?: string[]; interpreter?: "direct" | "shell" | "node" | "python"; intention: string }>("run_private_script", {
      description: "Run a script stored in the repository or one of its private skills inside the isolated read-only sandbox.", parameters: rawSchemas.script, defer: "never",
      handler: async ({ script, args = [], interpreter = "direct" }) => {
        const absolute = await resolveRepositoryPath(repository, script);
        const relative = path.relative(repository.canonicalPath, absolute);
        const executable = interpreter === "shell" ? "/bin/sh" : interpreter === "node" ? "node" : interpreter === "python" ? "python3" : "";
        const command = [executable, `/repo/${relative}`, ...args].filter(Boolean).map(quote).join(" ");
        return sandboxRequest("/execute", { repositoryId: repository.id, sessionId, command });
      }
    })
  ];
}

async function runTurn(job: Job<{ sessionId: string; turnId: string }>) {
  const lockKey = `session-lock:${job.data.sessionId}`;
  const lockValue = randomUUID();
  const locked = await redis.set(lockKey, lockValue, "EX", 900, "NX");
  if (!locked) throw new Error("Session is already processing another turn");
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
      systemMessage: { mode: "append" as const, content: "You are working with a live repository. The repository is strictly read-only. Never claim to have modified files. Use the provided repository tools for reading, and the controlled shell, URL, or private-script tools when needed. Commands run in an isolated container and may only write under temporary directories." },
      onPermissionRequest: permissionHandler(turn.session.id, turn.id)
    };
    const metadata = await client.getSessionMetadata(turn.session.sdkSessionId);
    sdkSession = metadata ? await client.resumeSession(turn.session.sdkSessionId, sessionOptions) : await client.createSession({ ...sessionOptions, sessionId: turn.session.sdkSessionId });
    activeSessions.set(turn.session.id, sdkSession);
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
    const titleUpdate = turn.session.title === "New chat" ? { title: prompt.replace(/\s+/g, " ").slice(0, 60) } : {};
    await db.$transaction([
      db.turn.update({ where: { id: turn.id }, data: { status: TurnStatus.COMPLETED, completedAt: new Date() } }),
      db.chatSession.update({ where: { id: turn.session.id }, data: { status: SessionStatus.IDLE, ...titleUpdate } })
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
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, lockValue);
  }
}

const turnWorker = new Worker(COPILOT_TURN_QUEUE, runTurn, { connection: queueConnection, concurrency: env.WORKER_CONCURRENCY });

const controlWorker = new Worker(COPILOT_CONTROL_QUEUE, async (job: Job) => {
  if (job.name === "list-models") {
    const account = await db.gitHubAccount.findUniqueOrThrow({ where: { id: String(job.data.githubAccountId) } });
    const token = decryptToken(account.encryptedAccessToken);
    const modelClient = new CopilotClient({ mode: "empty", baseDirectory: path.join(env.COPILOT_HOME, "model-clients", account.id), gitHubToken: token, useLoggedInUser: false, env: copilotRuntimeEnv });
    try {
      await modelClient.start();
      const models = await modelClient.listModels();
      return [{ id: "auto", name: "Auto", supportsReasoning: false }, ...models.map((model) => ({ id: model.id, name: model.name ?? model.id, supportsReasoning: Boolean(model.capabilities?.supports?.reasoningEffort) }))];
    } finally { await modelClient.stop(); }
  }
  const sessionId = String(job.data.sessionId);
  stopRequested.add(sessionId);
  const pending = await db.permissionRequest.findMany({ where: { sessionId, status: PermissionStatus.PENDING } });
  for (const request of pending) await redis.publish(`${PERMISSION_DECISION_CHANNEL_PREFIX}${request.id}`, "deny");
  if (pending.length) await db.permissionRequest.updateMany({ where: { sessionId, status: PermissionStatus.PENDING }, data: { status: PermissionStatus.DENIED, decidedAt: new Date() } });
  const active = activeSessions.get(sessionId);
  if (active) await active.abort().catch(() => undefined);
  await sandboxRequest(`/sessions/${sessionId}/stop`).catch(() => undefined);
  if (job.name === "delete-session") {
    const turnLock = `session-lock:${sessionId}`;
    const deadline = Date.now() + 30_000;
    while (await redis.exists(turnLock)) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the active Session turn to stop");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const deleteLock = `session-delete-lock:${sessionId}`;
    const deleteLockValue = randomUUID();
    if (!(await redis.set(deleteLock, deleteLockValue, "EX", 60, "NX"))) throw new Error("Session deletion is already in progress");
    try {
      await client.deleteSession(String(job.data.sdkSessionId)).catch((error) => {
        if (!(error instanceof Error && error.message.toLowerCase().includes("not found"))) throw error;
      });
      await rm(path.join(env.COPILOT_HOME, "skill-views", sessionId), { recursive: true, force: true });
    } finally {
      await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, deleteLock, deleteLockValue);
    }
  }
  return { ok: true };
}, { connection: queueConnection, concurrency: 4 });

await subscriber.psubscribe(`${STOP_CHANNEL_PREFIX}*`);
subscriber.on("pmessage", (_pattern: string, channel: string) => {
  const sessionId = channel.slice(STOP_CHANNEL_PREFIX.length);
  stopRequested.add(sessionId);
  const session = activeSessions.get(sessionId);
  if (session) void session.abort();
  void sandboxRequest(`/sessions/${sessionId}/stop`).catch(() => undefined);
});

async function shutdown() {
  for (const [sessionId, session] of activeSessions) {
    stopRequested.add(sessionId);
    const pending = await db.permissionRequest.findMany({ where: { sessionId, status: PermissionStatus.PENDING } });
    for (const request of pending) await redis.publish(`${PERMISSION_DECISION_CHANNEL_PREFIX}${request.id}`, "deny");
    if (pending.length) await db.permissionRequest.updateMany({ where: { sessionId, status: PermissionStatus.PENDING }, data: { status: PermissionStatus.DENIED, decidedAt: new Date() } });
    await session.abort().catch(() => undefined);
    await sandboxRequest(`/sessions/${sessionId}/stop`).catch(() => undefined);
  }
  await Promise.all([turnWorker.close(), controlWorker.close()]);
  await client.stop();
  registry.close();
  await Promise.all([subscriber.quit(), redis.quit(), db.$disconnect()]);
}
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
