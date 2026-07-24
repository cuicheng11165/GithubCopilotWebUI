import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

for (const name of ["REPOSITORIES_CONFIG", "COPILOT_HOME", "LOCAL_SANDBOX_TMP_ROOT"]) {
  const value = process.env[name];
  if (value?.startsWith("./")) process.env[name] = path.resolve(root, value);
}

process.env.NODE_ENV = "production";
process.env.WORKER_CONCURRENCY ??= "20";
process.env.API_INTERNAL_URL ??= "http://127.0.0.1:4000";

const webBuild = path.join(root, "apps/web/.next");
const webStandalone = path.join(webBuild, "standalone");
const webStandaloneApp = path.join(webStandalone, "apps/web");
const webStatic = path.join(webBuild, "static");
const webStandaloneStatic = path.join(webStandaloneApp, ".next/static");
if (existsSync(webStatic)) {
  mkdirSync(path.dirname(webStandaloneStatic), { recursive: true });
  cpSync(webStatic, webStandaloneStatic, { recursive: true, force: true });
}
const webPublic = path.join(root, "apps/web/public");
if (existsSync(webPublic)) cpSync(webPublic, path.join(webStandaloneApp, "public"), { recursive: true, force: true });

const programs = [
  { name: "api", cwd: root, entry: "apps/api/dist/server.js", args: [] },
  { name: "worker", cwd: root, entry: "apps/worker/dist/worker.js", args: [] },
  { name: "sandbox-runner", cwd: root, entry: "apps/sandbox-runner/dist/server.js", args: [] },
  { name: "web", cwd: webStandalone, entry: "apps/web/server.js", args: [], env: { HOSTNAME: "127.0.0.1", PORT: "3000" } }
];

for (const program of programs) {
  const entry = path.resolve(program.cwd, program.entry);
  if (!existsSync(entry)) throw new Error(`Missing ${program.name} build output: ${entry}. Run pnpm build first.`);
}

const children = programs.map((program) => spawn(process.execPath, [program.entry, ...program.args], {
  cwd: program.cwd,
  env: { ...process.env, ...program.env },
  stdio: "inherit"
}));

let stopping = false;
function shutdown(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

for (const [index, child] of children.entries()) {
  child.on("error", (error) => {
    console.error(`${programs[index].name} failed to start`, error);
    process.exitCode = 1;
    shutdown();
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${programs[index].name} exited`, signal ? `with ${signal}` : `with code ${code ?? 1}`);
    process.exitCode = code ?? 1;
    shutdown();
  });
}
