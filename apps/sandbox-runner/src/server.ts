import Fastify from "fastify";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { z } from "zod";
import { RepositoryRegistry } from "@app/repository-tools";
import { requestPublicUrl } from "./network.js";

const env = z.object({
  SANDBOX_RUNNER_PORT: z.coerce.number().int().positive().default(4100),
  SANDBOX_RUNNER_TOKEN: z.string().min(32),
  REPOSITORIES_CONFIG: z.string().min(1).default("./config/repositories.yaml"),
  CONTAINER_RUNTIME: z.enum(["docker", "podman"]).default("podman"),
  SANDBOX_DEFAULT_IMAGE: z.string().default("copilot-web-sandbox:local"),
  SANDBOX_ALLOWED_IMAGES: z.string().default("copilot-web-sandbox:local"),
  SANDBOX_NETWORK: z.string().default("copilot-egress"),
  SANDBOX_HTTP_PROXY: z.string().url().optional(),
  COMMAND_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  COMMAND_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().default(1_048_576)
}).parse(process.env);

const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });
const registry = new RepositoryRegistry(env.REPOSITORIES_CONFIG);
await registry.load();
registry.watch((error) => app.log.error(error, "Repository registry reload failed"));
const activeContainers = new Map<string, Set<string>>();
const allowedImages = new Set(env.SANDBOX_ALLOWED_IMAGES.split(",").map((image) => image.trim()).filter(Boolean));

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
  const image = repository.sandboxImage ?? env.SANDBOX_DEFAULT_IMAGE;
  if (!allowedImages.has(image)) return reply.code(400).send({ error: "Repository references a sandbox image that is not allowlisted" });
  const containerName = `copilot-sandbox-${parsed.data.sessionId}-${Date.now()}`;
  const names = activeContainers.get(parsed.data.sessionId) ?? new Set<string>();
  names.add(containerName);
  activeContainers.set(parsed.data.sessionId, names);
  const args = [
    "run", "--rm", "--name", containerName,
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=128", "--memory=1g", "--cpus=1.5",
    "--network", env.SANDBOX_NETWORK,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m",
    "--mount", `type=bind,src=${repository.canonicalPath},dst=/repo,readonly`,
    "--workdir", "/repo", "--user", "65532:65532",
    "--env", "HOME=/tmp", "--env", "XDG_CACHE_HOME=/tmp/cache",
    ...(env.SANDBOX_HTTP_PROXY ? ["--env", `HTTP_PROXY=${env.SANDBOX_HTTP_PROXY}`, "--env", `HTTPS_PROXY=${env.SANDBOX_HTTP_PROXY}`, "--env", `http_proxy=${env.SANDBOX_HTTP_PROXY}`, "--env", `https_proxy=${env.SANDBOX_HTTP_PROXY}`, "--env", "NO_PROXY=", "--env", "no_proxy="] : []),
    image, "/bin/sh", "-lc", parsed.data.command
  ];
  const child = spawn(env.CONTAINER_RUNTIME, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
    const current = target === "stdout" ? stdout : stderr;
    const remaining = env.COMMAND_MAX_OUTPUT_BYTES - Buffer.byteLength(current);
    if (remaining <= 0) { truncated = true; return; }
    const value = chunk.subarray(0, remaining).toString("utf8");
    if (target === "stdout") stdout += value; else stderr += value;
    if (chunk.byteLength > remaining) truncated = true;
  };
  child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
    const cleanup = spawn(env.CONTAINER_RUNTIME, ["rm", "-f", containerName], { stdio: "ignore", env: { PATH: process.env.PATH } });
    cleanup.unref();
  }, (parsed.data.timeoutSeconds ?? env.COMMAND_TIMEOUT_SECONDS) * 1000);
  let exitCode: number | null = null;
  let signal: string | null = null;
  try {
    const [code, childSignal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    exitCode = code;
    signal = childSignal;
  } finally {
    clearTimeout(timeout);
    names.delete(containerName);
    if (names.size === 0) activeContainers.delete(parsed.data.sessionId);
  }
  return { exitCode, signal, stdout, stderr, truncated, timedOut };
});

app.post<{ Params: { sessionId: string } }>("/sessions/:sessionId/stop", async (request) => {
  const names = [...(activeContainers.get(request.params.sessionId) ?? [])];
  await Promise.all(names.map(async (name) => {
    const child = spawn(env.CONTAINER_RUNTIME, ["rm", "-f", name], { stdio: "ignore", env: { PATH: process.env.PATH } });
    await once(child, "exit");
  }));
  activeContainers.delete(request.params.sessionId);
  return { stopped: names.length };
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
  try { registry.list(); return { status: "ready" }; } catch { return reply.code(503).send({ status: "not-ready" }); }
});
app.addHook("onClose", async () => registry.close());

await app.listen({ host: "0.0.0.0", port: env.SANDBOX_RUNNER_PORT });
