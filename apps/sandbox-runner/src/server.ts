import Fastify from "fastify";
import { z } from "zod";
import { RepositoryRegistry } from "@app/repository-tools";
import { ExecutionManager } from "./execution.js";
import { requestPublicUrl } from "./network.js";
import { applyRepositoryPatch } from "./patch.js";

const env = z.object({
  SANDBOX_RUNNER_HOST: z.string().default("127.0.0.1"),
  SANDBOX_RUNNER_PORT: z.coerce.number().int().positive().default(4100),
  SANDBOX_RUNNER_TOKEN: z.string().min(32),
  REPOSITORIES_CONFIG: z.string().min(1).default("./config/repositories.yaml"),
  COMMAND_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  COMMAND_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  LOCAL_SANDBOX_TMP_ROOT: z.string().default("./data/local-sandbox")
}).parse(process.env);

const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });
const registry = new RepositoryRegistry(env.REPOSITORIES_CONFIG);
await registry.load();
registry.watch((error) => app.log.error(error, "Repository registry reload failed"));
const executions = new ExecutionManager();

app.log.warn("Commands and private scripts run directly as the GithubCopilotWebUI host user without isolation");

app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith("/health/")) return;
  if (request.headers.authorization !== `Bearer ${env.SANDBOX_RUNNER_TOKEN}`) return reply.code(401).send({ error: "Unauthorized" });
});

const executeSchema = z.object({
  repositoryId: z.string(),
  sessionId: z.string().uuid(),
  command: z.string().min(1).max(100_000),
  executable: z.string().min(1).max(32_768).optional(),
  args: z.array(z.string().max(32_768)).max(256).optional(),
  timeoutSeconds: z.number().int().positive().max(600).optional()
});

app.post("/execute", async (request, reply) => {
  const parsed = executeSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid execution request" });
  let repository;
  try { repository = registry.get(parsed.data.repositoryId); } catch { return reply.code(404).send({ error: "Repository not found" }); }
  return executions.execute({
    sessionId: parsed.data.sessionId,
    command: parsed.data.command,
    timeoutSeconds: parsed.data.timeoutSeconds ?? env.COMMAND_TIMEOUT_SECONDS,
    maxOutputBytes: env.COMMAND_MAX_OUTPUT_BYTES,
    repositoryPath: repository.canonicalPath,
    tempRoot: env.LOCAL_SANDBOX_TMP_ROOT,
    ...(parsed.data.executable ? { executable: parsed.data.executable, args: parsed.data.args ?? [] } : {})
  });
});

app.post("/bash", async (request, reply) => {
  const parsed = executeSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid bash request" });
  let repository;
  try { repository = registry.get(parsed.data.repositoryId); } catch { return reply.code(404).send({ error: "Repository not found" }); }
  return executions.start({
    sessionId: parsed.data.sessionId,
    command: parsed.data.command,
    timeoutSeconds: parsed.data.timeoutSeconds ?? env.COMMAND_TIMEOUT_SECONDS,
    maxOutputBytes: env.COMMAND_MAX_OUTPUT_BYTES,
    repositoryPath: repository.canonicalPath,
    tempRoot: env.LOCAL_SANDBOX_TMP_ROOT
  });
});

const bashLookupSchema = z.object({
  sessionId: z.string().uuid(),
  bashId: z.string().uuid(),
  tailLines: z.number().int().positive().max(5_000).optional()
});

app.post("/bash/read", async (request, reply) => {
  const parsed = bashLookupSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid bash read request" });
  try {
    return executions.read(parsed.data.sessionId, parsed.data.bashId, parsed.data.tailLines);
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "Bash execution not found" });
  }
});

app.post("/bash/list", async (request, reply) => {
  const parsed = z.object({ sessionId: z.string().uuid() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid bash list request" });
  return executions.list(parsed.data.sessionId);
});

app.post("/bash/stop", async (request, reply) => {
  const parsed = bashLookupSchema.omit({ tailLines: true }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid bash stop request" });
  try {
    return await executions.stopOne(parsed.data.sessionId, parsed.data.bashId);
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "Bash execution not found" });
  }
});

const patchSchema = z.object({
  repositoryId: z.string(),
  patch: z.string().min(1).max(512_000)
});

app.post("/apply-patch", async (request, reply) => {
  const parsed = patchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid patch request" });
  let repository;
  try { repository = registry.get(parsed.data.repositoryId); } catch { return reply.code(404).send({ error: "Repository not found" }); }
  try {
    return await applyRepositoryPatch(repository.canonicalPath, parsed.data.patch);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "Patch could not be applied" });
  }
});

app.post<{ Params: { sessionId: string } }>("/sessions/:sessionId/stop", async (request) => {
  return { stopped: await executions.stop(request.params.sessionId) };
});

const fetchSchema = z.object({ url: z.string().url(), maxBytes: z.number().int().positive().max(2_000_000).default(1_000_000) });
app.post("/fetch", async (request, reply) => {
  const parsed = fetchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid URL request" });
  try {
    return await requestPublicUrl(parsed.data.url, parsed.data.maxBytes);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "URL fetch failed" });
  }
});

app.get("/health/live", async () => ({ status: "ok" }));
app.get("/health/ready", async (_request, reply) => {
  try { registry.list(); return { status: "ready", executionMode: "local" }; } catch { return reply.code(503).send({ status: "not-ready" }); }
});
app.addHook("onClose", async () => registry.close());

await app.listen({ host: env.SANDBOX_RUNNER_HOST, port: env.SANDBOX_RUNNER_PORT });
