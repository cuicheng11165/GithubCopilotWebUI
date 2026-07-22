import Fastify from "fastify";
import { z } from "zod";
import { RepositoryRegistry } from "@app/repository-tools";
import { ExecutionManager } from "./execution.js";
import { requestPublicUrl } from "./network.js";

const env = z.object({
  SANDBOX_RUNNER_HOST: z.string().default("127.0.0.1"),
  SANDBOX_RUNNER_PORT: z.coerce.number().int().positive().default(4100),
  SANDBOX_RUNNER_TOKEN: z.string().min(32),
  REPOSITORIES_CONFIG: z.string().min(1).default("./config/repositories.yaml"),
  SANDBOX_BACKEND: z.enum(["local", "container"]).default("local"),
  CONTAINER_RUNTIME: z.enum(["docker", "podman"]).default("podman"),
  SANDBOX_DEFAULT_IMAGE: z.string().default("copilot-web-sandbox:local"),
  SANDBOX_ALLOWED_IMAGES: z.string().default("copilot-web-sandbox:local"),
  SANDBOX_NETWORK: z.string().default("copilot-egress"),
  SANDBOX_HTTP_PROXY: z.string().url().optional(),
  COMMAND_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  COMMAND_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  LOCAL_SANDBOX_TMP_ROOT: z.string().default("./data/local-sandbox")
}).parse(process.env);

const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });
const registry = new RepositoryRegistry(env.REPOSITORIES_CONFIG);
await registry.load();
registry.watch((error) => app.log.error(error, "Repository registry reload failed"));
const allowedImages = new Set(env.SANDBOX_ALLOWED_IMAGES.split(",").map((image) => image.trim()).filter(Boolean));
const executions = new ExecutionManager();

if (env.SANDBOX_BACKEND === "local") {
  app.log.warn("SANDBOX_BACKEND=local: commands and private scripts run directly as the CopilotDeck host user without isolation");
}

app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith("/health/")) return;
  if (request.headers.authorization !== `Bearer ${env.SANDBOX_RUNNER_TOKEN}`) return reply.code(401).send({ error: "Unauthorized" });
});

const executeSchema = z.object({
  repositoryId: z.string(),
  sessionId: z.string().uuid(),
  command: z.string().min(1).max(100_000),
  timeoutSeconds: z.number().int().positive().max(600).optional()
});

app.post("/execute", async (request, reply) => {
  const parsed = executeSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid execution request" });
  let repository;
  try { repository = registry.get(parsed.data.repositoryId); } catch { return reply.code(404).send({ error: "Repository not found" }); }
  const common = {
    sessionId: parsed.data.sessionId,
    command: parsed.data.command,
    timeoutSeconds: parsed.data.timeoutSeconds ?? env.COMMAND_TIMEOUT_SECONDS,
    maxOutputBytes: env.COMMAND_MAX_OUTPUT_BYTES
  };
  if (env.SANDBOX_BACKEND === "local") {
    return executions.executeLocal({ ...common, repositoryPath: repository.canonicalPath, tempRoot: env.LOCAL_SANDBOX_TMP_ROOT });
  }
  const image = repository.sandboxImage ?? env.SANDBOX_DEFAULT_IMAGE;
  if (!allowedImages.has(image)) return reply.code(400).send({ error: "Repository references a sandbox image that is not allowlisted" });
  return executions.executeContainer({
    ...common,
    containerName: `copilot-sandbox-${parsed.data.sessionId}-${Date.now()}`,
    repositoryPath: repository.canonicalPath,
    runtime: env.CONTAINER_RUNTIME,
    image,
    network: env.SANDBOX_NETWORK,
    ...(env.SANDBOX_HTTP_PROXY ? { httpProxy: env.SANDBOX_HTTP_PROXY } : {})
  });
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
  try { registry.list(); return { status: "ready", sandboxBackend: env.SANDBOX_BACKEND }; } catch { return reply.code(503).send({ status: "not-ready" }); }
});
app.addHook("onClose", async () => registry.close());

await app.listen({ host: env.SANDBOX_RUNNER_HOST, port: env.SANDBOX_RUNNER_PORT });
