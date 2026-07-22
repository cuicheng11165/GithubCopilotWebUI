import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import {
  createSessionSchema,
  permissionDecisionSchema,
  sendMessageSchema,
  updateSessionSchema,
  type ApprovalMode,
  type ApprovalScope
} from "@app/contracts";
import { ApprovalMode as DbApprovalMode, MessageRole, PermissionStatus, Prisma, SessionStatus, TurnStatus, db, toDatabaseCursor, type ChatSession as DbChatSession } from "@app/db";
import { RepositoryRegistry, getGitInfo, scanSkills } from "@app/repository-tools";
import { authenticate, ownedSession, SESSION_COOKIE } from "./auth.js";
import { config } from "./config.js";
import { MemoryEphemeralStore, type EphemeralStore } from "./ephemeral-store.js";
import { registerOAuthRoutes } from "./oauth.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie"] } });
const registry = new RepositoryRegistry(config.REPOSITORIES_CONFIG);
const deletingSessions = new Set<string>();
const ephemeral: EphemeralStore = new MemoryEphemeralStore();

app.decorate("ephemeral", ephemeral);
await app.register(cookie, { secret: config.COOKIE_SECRET });
await app.register(cors, { origin: config.PUBLIC_APP_URL, credentials: true, allowedHeaders: ["Content-Type", "Idempotency-Key", "X-CSRF-Token", "Last-Event-ID"] });
await registry.load();
registry.watch((error) => app.log.error(error, "Repository config reload failed; keeping previous config"));
registerOAuthRoutes(app);

function fromDbApprovalMode(value: string): ApprovalMode {
  return value === DbApprovalMode.ALLOW_ALL ? "allow-all" : value === DbApprovalMode.SESSION_SCOPED ? "session-scoped" : "interactive";
}

function toDbApprovalMode(value: ApprovalMode): DbApprovalMode {
  return value === "allow-all" ? DbApprovalMode.ALLOW_ALL : value === "session-scoped" ? DbApprovalMode.SESSION_SCOPED : DbApprovalMode.INTERACTIVE;
}

function statusName(value: string): "idle" | "queued" | "running" | "waiting-approval" | "error" {
  const map = { IDLE: "idle", QUEUED: "queued", RUNNING: "running", WAITING_APPROVAL: "waiting-approval", ERROR: "error" } as const;
  return map[value as keyof typeof map] ?? "error";
}

function approvalScopesFromDb(value: Prisma.JsonValue): ApprovalScope[] {
  if (!Array.isArray(value)) return [];
  return value.filter((scope): scope is ApprovalScope => scope === "shell" || scope === "url" || scope === "private-script");
}

function serializeSession(session: DbChatSession) {
  return {
    id: session.id,
    title: session.title,
    repositoryId: session.repositoryId,
    repositoryName: session.repositoryName,
    model: session.model,
    approvalMode: fromDbApprovalMode(session.approvalMode),
    approvalScopes: approvalScopesFromDb(session.approvalScopes),
    status: statusName(session.status),
    branch: session.branch,
    headSha: session.headSha,
    dirty: session.dirty,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString()
  };
}

async function workerRequest<T>(pathname: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.WORKER_CONTROL_URL}${pathname}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.WORKER_CONTROL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const result = await response.json().catch(() => ({ error: response.statusText })) as T & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Worker returned ${response.status}`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkWorker(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`${config.WORKER_CONTROL_URL}/health/ready`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Worker health returned ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function appendEvent(sessionId: string, turnId: string | null, kind: string, data: Record<string, unknown>) {
  await db.sessionEvent.create({ data: { sessionId, turnId, kind, data: data as Prisma.InputJsonValue } });
}

async function rejectPendingPermissions(sessionId: string, userId: string, reason: string) {
  const pending = await db.permissionRequest.findMany({ where: { sessionId, status: PermissionStatus.PENDING } });
  for (const permission of pending) {
    const changed = await db.permissionRequest.updateMany({
      where: { id: permission.id, status: PermissionStatus.PENDING },
      data: { status: PermissionStatus.DENIED, decidedAt: new Date() }
    });
    if (changed.count === 0) continue;
    await db.auditLog.create({ data: { userId, action: "permission.denied-by-lifecycle", targetId: permission.id, metadata: { sessionId, scope: permission.scope, reason } } });
    await appendEvent(sessionId, permission.turnId, "permission.completed", { requestId: permission.id, decision: "deny", reason });
  }
}

async function requestWorkerStop(session: { id: string; sdkSessionId: string }, requestedBy: string, reason: string): Promise<void> {
  await workerRequest(`/sessions/${session.id}/stop`, { sdkSessionId: session.sdkSessionId, requestedBy, reason });
}

app.get("/health/live", async () => ({ status: "ok" }));
app.get("/health/ready", async (_request, reply) => {
  try {
    await db.$queryRaw`SELECT 1`;
    await checkWorker();
    return { status: "ready", database: "sqlite" };
  } catch {
    return reply.code(503).send({ status: "not-ready" });
  }
});

app.get("/api/me", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  return {
    id: auth.user.id,
    login: auth.user.login,
    displayName: auth.user.displayName,
    avatarUrl: auth.user.avatarUrl,
    provider: auth.account.provider,
    csrfToken: auth.webSession.csrfToken
  };
});

app.get("/api/runtime", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  return { sandboxBackend: config.SANDBOX_BACKEND };
});

app.post("/api/auth/logout", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  const active = await db.chatSession.findMany({ where: { userId: auth.user.id, status: { in: [SessionStatus.QUEUED, SessionStatus.RUNNING, SessionStatus.WAITING_APPROVAL] } } });
  for (const session of active) {
    await db.$transaction([
      db.turn.updateMany({ where: { sessionId: session.id, status: { in: [TurnStatus.QUEUED, TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } }, data: { status: TurnStatus.STOPPED, completedAt: new Date() } }),
      db.chatSession.update({ where: { id: session.id }, data: { status: SessionStatus.IDLE } })
    ]);
    await rejectPendingPermissions(session.id, auth.user.id, "logout");
    await requestWorkerStop(session, auth.user.id, "logout").catch((error) => request.log.error(error, "Failed to stop Session during logout"));
  }
  await db.webSession.delete({ where: { id: auth.webSession.id } });
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return reply.code(204).send();
});

app.get("/api/repositories", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  return Promise.all(registry.list().map(async (repository) => {
    const [git, skills] = await Promise.all([getGitInfo(repository), scanSkills(repository)]);
    return {
      id: repository.id,
      displayName: repository.displayName,
      enabled: repository.enabled,
      ...git,
      skills: skills.map(({ name, description, source, warning }) => ({ name, description, source, warning }))
    };
  }));
});

app.get("/api/models", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  try {
    return await workerRequest("/models", { githubAccountId: auth.account.id });
  } catch {
    return [{ id: "auto", name: "Auto", supportsReasoning: false }];
  }
});

app.get("/api/sessions", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  const sessions = await db.chatSession.findMany({ where: { userId: auth.user.id }, orderBy: { updatedAt: "desc" } });
  return sessions.map(serializeSession);
});

app.post("/api/sessions", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  const parsed = createSessionSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid session configuration", details: parsed.error.flatten() });
  let repository;
  try { repository = registry.get(parsed.data.repositoryId); } catch { return reply.code(404).send({ error: "Repository not found" }); }
  const [git, skills] = await Promise.all([getGitInfo(repository), scanSkills(repository)]);
  const session = await db.chatSession.create({ data: {
    sdkSessionId: `user-${auth.user.id}-session-${randomUUID()}`,
    userId: auth.user.id,
    githubAccountId: auth.account.id,
    repositoryId: repository.id,
    repositoryName: repository.displayName,
    model: parsed.data.model,
    approvalMode: toDbApprovalMode(parsed.data.approvalMode),
    approvalScopes: parsed.data.approvalScopes,
    branch: git.branch,
    headSha: git.headSha,
    dirty: git.dirty,
    skillManifest: skills.map(({ name, description, source, warning, contentHash }) => ({ name, description, source, warning, contentHash }))
  } });
  await db.auditLog.create({ data: { userId: auth.user.id, action: "session.created", targetId: session.id, metadata: { repositoryId: repository.id } } });
  return reply.code(201).send(serializeSession(session));
});

app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  const session = await db.chatSession.findFirst({ where: { id: request.params.id, userId: auth.user.id }, include: {
    messages: { orderBy: { createdAt: "asc" } },
    permissionRequests: { where: { status: PermissionStatus.PENDING }, orderBy: { createdAt: "asc" } }
  } });
  if (!session) return reply.code(404).send({ error: "Session not found" });
  const { messages, permissionRequests, ...sessionData } = session;
  return {
    session: serializeSession(sessionData),
    messages: messages.map((message) => ({ ...message, role: message.role.toLowerCase(), createdAt: message.createdAt.toISOString() })),
    permissions: permissionRequests.map((permission) => ({
      id: permission.id,
      sessionId: permission.sessionId,
      turnId: permission.turnId,
      scope: permission.scope,
      intention: permission.intention,
      display: permission.display,
      status: permission.status.toLowerCase(),
      expiresAt: permission.expiresAt.toISOString()
    })),
    skills: session.skillManifest ?? []
  };
});

app.patch<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  const session = await ownedSession(auth.user.id, request.params.id);
  if (!session) return reply.code(404).send({ error: "Session not found" });
  const parsed = updateSessionSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid update", details: parsed.error.flatten() });
  const nextMode = parsed.data.approvalMode ?? fromDbApprovalMode(session.approvalMode);
  const nextScopes = parsed.data.approvalScopes ?? approvalScopesFromDb(session.approvalScopes);
  if (nextMode !== "session-scoped" && nextScopes.length > 0) return reply.code(400).send({ error: "Approval scopes are only valid in session-scoped mode" });
  const updated = await db.chatSession.update({ where: { id: session.id }, data: {
    ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
    ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
    ...(parsed.data.approvalMode !== undefined ? { approvalMode: toDbApprovalMode(parsed.data.approvalMode) } : {}),
    ...(parsed.data.approvalScopes !== undefined ? { approvalScopes: parsed.data.approvalScopes } : {})
  } });
  await appendEvent(session.id, null, "session.updated", serializeSession(updated));
  return serializeSession(updated);
});

app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  const session = await ownedSession(auth.user.id, request.params.id);
  if (!session) return reply.code(404).send({ error: "Session not found" });
  if (deletingSessions.has(session.id)) return reply.code(409).send({ error: "Session deletion is already in progress" });
  deletingSessions.add(session.id);
  try {
    await db.$transaction([
      db.turn.updateMany({ where: { sessionId: session.id, status: { in: [TurnStatus.QUEUED, TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } }, data: { status: TurnStatus.STOPPED, completedAt: new Date() } }),
      db.chatSession.update({ where: { id: session.id }, data: { status: SessionStatus.IDLE } })
    ]);
    await rejectPendingPermissions(session.id, auth.user.id, "delete");
    try {
      await workerRequest(`/sessions/${session.id}/delete`, { sdkSessionId: session.sdkSessionId, requestedBy: auth.user.id }, 45_000);
    } catch (error) {
      request.log.error(error, "Failed to delete SDK session state");
      return reply.code(503).send({ error: "Session deletion could not be completed" });
    }
    await db.$transaction([
      db.chatSession.delete({ where: { id: session.id } }),
      db.auditLog.create({ data: { userId: auth.user.id, action: "session.deleted", targetId: session.id } })
    ]);
    return reply.code(204).send();
  } finally {
    deletingSessions.delete(session.id);
  }
});

app.post<{ Params: { id: string } }>("/api/sessions/:id/messages", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  const session = await ownedSession(auth.user.id, request.params.id);
  if (!session) return reply.code(404).send({ error: "Session not found" });
  if (deletingSessions.has(session.id)) return reply.code(409).send({ error: "Session is being deleted" });
  const parsed = sendMessageSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid message", details: parsed.error.flatten() });
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length > 200) return reply.code(400).send({ error: "Idempotency-Key header is required" });
  const existing = await db.turn.findUnique({ where: { sessionId_idempotencyKey: { sessionId: session.id, idempotencyKey } } });
  if (existing) return reply.code(202).send({ turnId: existing.id, status: existing.status.toLowerCase() });
  const turn = await db.$transaction(async (tx) => {
    const created = await tx.turn.create({ data: { sessionId: session.id, idempotencyKey, status: TurnStatus.QUEUED } });
    await tx.message.create({ data: { sessionId: session.id, turnId: created.id, role: MessageRole.USER, content: parsed.data.content } });
    await tx.chatSession.update({ where: { id: session.id }, data: { status: SessionStatus.QUEUED } });
    return created;
  });
  await appendEvent(session.id, turn.id, "turn.queued", { turnId: turn.id, content: parsed.data.content });
  return reply.code(202).send({ turnId: turn.id, status: "queued" });
});

app.post<{ Params: { id: string } }>("/api/sessions/:id/stop", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  const session = await ownedSession(auth.user.id, request.params.id);
  if (!session) return reply.code(404).send({ error: "Session not found" });
  await db.$transaction([
    db.turn.updateMany({ where: { sessionId: session.id, status: { in: [TurnStatus.QUEUED, TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } }, data: { status: TurnStatus.STOPPED, completedAt: new Date() } }),
    db.chatSession.update({ where: { id: session.id }, data: { status: SessionStatus.IDLE } })
  ]);
  await rejectPendingPermissions(session.id, auth.user.id, "stop");
  await requestWorkerStop(session, auth.user.id, "stop").catch((error) => request.log.error(error, "Failed to signal Worker stop"));
  return reply.code(202).send({ status: "stopping" });
});

app.post<{ Params: { id: string; requestId: string } }>("/api/sessions/:id/permissions/:requestId/respond", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  const session = await ownedSession(auth.user.id, request.params.id);
  if (!session) return reply.code(404).send({ error: "Session not found" });
  const parsed = permissionDecisionSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid decision" });
  const permission = await db.permissionRequest.findFirst({ where: { id: request.params.requestId, sessionId: session.id, status: PermissionStatus.PENDING } });
  if (!permission || permission.expiresAt <= new Date()) return reply.code(409).send({ error: "Permission request is no longer pending" });
  const status = parsed.data.decision === "approve-once" ? PermissionStatus.APPROVED : PermissionStatus.DENIED;
  await db.$transaction([
    db.permissionRequest.update({ where: { id: permission.id }, data: { status, decidedAt: new Date() } }),
    db.auditLog.create({ data: { userId: auth.user.id, action: `permission.${parsed.data.decision}`, targetId: permission.id, metadata: { sessionId: session.id, scope: permission.scope } } })
  ]);
  await appendEvent(session.id, permission.turnId, "permission.completed", { requestId: permission.id, decision: parsed.data.decision });
  return { status: parsed.data.decision };
});

app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/sessions/:id/events", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  const session = await ownedSession(auth.user.id, request.params.id);
  if (!session) return reply.code(404).send({ error: "Session not found" });
  const headerCursor = request.headers["last-event-id"];
  const cursorText = request.query.after ?? (typeof headerCursor === "string" ? headerCursor : "0");
  if (!/^\d+$/.test(cursorText)) return reply.code(400).send({ error: "Invalid event cursor" });
  const after = BigInt(cursorText);
  try { toDatabaseCursor(after); } catch { return reply.code(400).send({ error: "Invalid event cursor" }); }
  let lastSent = after;
  const write = (event: { cursor: number; kind: string } & Record<string, unknown>) => {
    const cursor = BigInt(event.cursor);
    if (cursor <= lastSent) return;
    lastSent = cursor;
    reply.raw.write(`id: ${event.cursor}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
  let closed = false;
  request.raw.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
  });
  void (async () => {
    while (!closed) {
      const backlog = await db.sessionEvent.findMany({
        where: { sessionId: session.id, cursor: { gt: toDatabaseCursor(lastSent) } },
        orderBy: { cursor: "asc" },
        take: 2_000
      });
      for (const event of backlog) write({ cursor: Number(event.cursor), kind: event.kind, sessionId: event.sessionId, turnId: event.turnId, data: event.data, createdAt: event.createdAt.toISOString() });
      if (backlog.length < 2_000) await new Promise((resolve) => setTimeout(resolve, config.EVENT_POLL_INTERVAL_MS));
    }
  })().catch((error) => {
    request.log.error(error, "SSE polling failed");
    if (!closed) reply.raw.end();
  });
});

app.addHook("onClose", async () => {
  registry.close();
  await Promise.all([
    app.ephemeral.close(),
    db.$disconnect()
  ]);
});

await app.listen({ host: config.API_HOST, port: config.API_PORT });
