import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { Redis } from "ioredis";
import { Queue, QueueEvents } from "bullmq";
import { randomUUID } from "node:crypto";
import {
  COPILOT_CONTROL_QUEUE,
  COPILOT_TURN_QUEUE,
  PERMISSION_DECISION_CHANNEL_PREFIX,
  SESSION_EVENT_CHANNEL_PREFIX,
  STOP_CHANNEL_PREFIX,
  createSessionSchema,
  permissionDecisionSchema,
  sendMessageSchema,
  updateSessionSchema,
  type ApprovalMode
} from "@app/contracts";
import { ApprovalMode as DbApprovalMode, MessageRole, PermissionStatus, Prisma, SessionStatus, TurnStatus, databaseMode, db, toDatabaseCursor, type ChatSession as DbChatSession } from "@app/db";
import { RepositoryRegistry, getGitInfo, scanSkills } from "@app/repository-tools";
import { authenticate, ownedSession, SESSION_COOKIE } from "./auth.js";
import { config } from "./config.js";
import { registerOAuthRoutes } from "./oauth.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie"] } });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queueUrl = new URL(config.REDIS_URL);
const queueConnection = {
  host: queueUrl.hostname,
  port: Number(queueUrl.port || 6379),
  ...(queueUrl.username ? { username: decodeURIComponent(queueUrl.username) } : {}),
  ...(queueUrl.password ? { password: decodeURIComponent(queueUrl.password) } : {}),
  ...(queueUrl.protocol === "rediss:" ? { tls: {} } : {})
};
const turns = new Queue(COPILOT_TURN_QUEUE, { connection: queueConnection });
const controls = new Queue(COPILOT_CONTROL_QUEUE, { connection: queueConnection });
const controlEvents = new QueueEvents(COPILOT_CONTROL_QUEUE, { connection: queueConnection });
const registry = new RepositoryRegistry(config.REPOSITORIES_CONFIG);

app.decorate("redis", redis);
await app.register(cookie, { secret: config.COOKIE_SECRET });
await app.register(cors, { origin: config.PUBLIC_APP_URL, credentials: true, allowedHeaders: ["Content-Type", "Idempotency-Key", "X-CSRF-Token", "Last-Event-ID"] });
await registry.load();
registry.watch((error) => app.log.error(error, "Repository config reload failed; keeping previous config"));
registerOAuthRoutes(app);

function fromDbApprovalMode(value: DbApprovalMode): ApprovalMode {
  return value === DbApprovalMode.ALLOW_ALL ? "allow-all" : value === DbApprovalMode.SESSION_SCOPED ? "session-scoped" : "interactive";
}

function toDbApprovalMode(value: ApprovalMode): DbApprovalMode {
  return value === "allow-all" ? DbApprovalMode.ALLOW_ALL : value === "session-scoped" ? DbApprovalMode.SESSION_SCOPED : DbApprovalMode.INTERACTIVE;
}

function statusName(value: SessionStatus): "idle" | "queued" | "running" | "waiting-approval" | "error" {
  const map = { IDLE: "idle", QUEUED: "queued", RUNNING: "running", WAITING_APPROVAL: "waiting-approval", ERROR: "error" } as const;
  return map[value];
}

function serializeSession(session: DbChatSession) {
  return {
    id: session.id,
    title: session.title,
    repositoryId: session.repositoryId,
    repositoryName: session.repositoryName,
    model: session.model,
    approvalMode: fromDbApprovalMode(session.approvalMode),
    approvalScopes: session.approvalScopes,
    status: statusName(session.status),
    branch: session.branch,
    headSha: session.headSha,
    dirty: session.dirty,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString()
  };
}

async function appendEvent(sessionId: string, turnId: string | null, kind: string, data: Record<string, unknown>) {
  const event = await db.sessionEvent.create({ data: { sessionId, turnId, kind, data: data as Prisma.InputJsonValue } });
  const serialized = { cursor: Number(event.cursor), sessionId, turnId, kind, data, createdAt: event.createdAt.toISOString() };
  await redis.publish(`${SESSION_EVENT_CHANNEL_PREFIX}${sessionId}`, JSON.stringify(serialized));
  return serialized;
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
    await redis.publish(`${PERMISSION_DECISION_CHANNEL_PREFIX}${permission.id}`, "deny");
    await appendEvent(sessionId, permission.turnId, "permission.completed", { requestId: permission.id, decision: "deny", reason });
  }
}

app.get("/health/live", async () => ({ status: "ok" }));
app.get("/health/ready", async (_request, reply) => {
  try {
    await Promise.all([db.$queryRaw`SELECT 1`, redis.ping()]);
    return { status: "ready", databaseMode };
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
    await redis.publish(`${STOP_CHANNEL_PREFIX}${session.id}`, JSON.stringify({ requestedBy: auth.user.id, reason: "logout" }));
    await controls.add("stop-session", { sessionId: session.id, sdkSessionId: session.sdkSessionId }, { removeOnComplete: 100, removeOnFail: 100 });
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
  const job = await controls.add("list-models", { githubAccountId: auth.account.id }, { removeOnComplete: 100, removeOnFail: 100 });
  try {
    return await job.waitUntilFinished(controlEvents, 30_000);
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
  const nextScopes = parsed.data.approvalScopes ?? session.approvalScopes;
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
  const deletionKey = `session-delete-requested:${session.id}`;
  const deletionToken = randomUUID();
  if (!(await redis.set(deletionKey, deletionToken, "EX", 60, "NX"))) return reply.code(409).send({ error: "Session deletion is already in progress" });
  try {
    await rejectPendingPermissions(session.id, auth.user.id, "delete");
    await redis.publish(`${STOP_CHANNEL_PREFIX}${session.id}`, JSON.stringify({ requestedBy: auth.user.id, reason: "delete" }));
    const job = await controls.add("delete-session", { sessionId: session.id, sdkSessionId: session.sdkSessionId }, { removeOnComplete: true, removeOnFail: 100 });
    try { await job.waitUntilFinished(controlEvents, 30_000); } catch (error) {
      request.log.error(error, "Failed to delete SDK session state");
      return reply.code(503).send({ error: "Session deletion could not be completed" });
    }
    await db.$transaction([
      db.chatSession.delete({ where: { id: session.id } }),
      db.auditLog.create({ data: { userId: auth.user.id, action: "session.deleted", targetId: session.id } })
    ]);
    return reply.code(204).send();
  } finally {
    await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, deletionKey, deletionToken);
  }
});

app.post<{ Params: { id: string } }>("/api/sessions/:id/messages", async (request, reply) => {
  const auth = await authenticate(request, reply);
  if (!(auth && "user" in auth)) return;
  const session = await ownedSession(auth.user.id, request.params.id);
  if (!session) return reply.code(404).send({ error: "Session not found" });
  if (await redis.exists(`session-delete-requested:${session.id}`)) return reply.code(409).send({ error: "Session is being deleted" });
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
  await turns.add("run-turn", { sessionId: session.id, turnId: turn.id }, {
    jobId: turn.id,
    attempts: 50,
    backoff: { type: "fixed", delay: 1_000 },
    removeOnComplete: 500,
    removeOnFail: 500
  });
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
  await redis.publish(`${STOP_CHANNEL_PREFIX}${session.id}`, JSON.stringify({ requestedBy: auth.user.id }));
  await controls.add("stop-session", { sessionId: session.id, sdkSessionId: session.sdkSessionId }, { removeOnComplete: 100, removeOnFail: 100 });
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
  await redis.publish(`${PERMISSION_DECISION_CHANNEL_PREFIX}${permission.id}`, parsed.data.decision);
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
  const channel = `${SESSION_EVENT_CHANNEL_PREFIX}${session.id}`;
  const eventSubscriber = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  let lastSent = after;
  let replaying = true;
  const buffered: Array<{ cursor: number; kind: string } & Record<string, unknown>> = [];
  const write = (event: { cursor: number; kind: string } & Record<string, unknown>) => {
    const cursor = BigInt(event.cursor);
    if (cursor <= lastSent) return;
    lastSent = cursor;
    reply.raw.write(`id: ${event.cursor}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const listener = (incomingChannel: string, message: string) => {
    if (incomingChannel !== channel) return;
    const event = JSON.parse(message) as { cursor: number; kind: string } & Record<string, unknown>;
    if (replaying) buffered.push(event); else write(event);
  };
  eventSubscriber.on("message", listener);
  await eventSubscriber.subscribe(channel);
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const backlog = await db.sessionEvent.findMany({ where: { sessionId: session.id, cursor: { gt: toDatabaseCursor(after) } }, orderBy: { cursor: "asc" }, take: 2_000 });
  for (const event of backlog) write({ cursor: Number(event.cursor), kind: event.kind, sessionId: event.sessionId, turnId: event.turnId, data: event.data, createdAt: event.createdAt.toISOString() });
  replaying = false;
  buffered.sort((left, right) => left.cursor - right.cursor).forEach(write);
  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    eventSubscriber.off("message", listener);
    void eventSubscriber.quit();
  });
});

app.addHook("onClose", async () => {
  registry.close();
  await Promise.all([turns.close(), controls.close(), controlEvents.close(), redis.quit(), db.$disconnect()]);
});

await app.listen({ host: "0.0.0.0", port: config.API_PORT });
