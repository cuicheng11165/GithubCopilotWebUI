import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

for (const name of ["REPOSITORIES_CONFIG", "COPILOT_HOME", "LOCAL_SANDBOX_TMP_ROOT"]) {
  const value = process.env[name];
  if (value?.startsWith("./")) process.env[name] = path.resolve(root, value);
}

process.env.DATABASE_MODE ??= "local";
process.env.COORDINATION_BACKEND ??= "local";
process.env.SANDBOX_BACKEND ??= "local";
process.env.WORKER_CONCURRENCY ??= process.env.LOCAL_WORKER_CONCURRENCY ?? "2";

const pnpmCli = process.env.npm_execpath;
const command = pnpmCli ? process.execPath : "pnpm";
const buildArgs = pnpmCli
  ? [pnpmCli, "--filter", "./packages/*", "build"]
  : ["--filter", "./packages/*", "build"];
const build = spawnSync(command, buildArgs, { cwd: root, env: process.env, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const args = pnpmCli
  ? [pnpmCli, "--parallel", "--filter", "@app/*", "dev"]
  : ["--parallel", "--filter", "@app/*", "dev"];
const child = spawn(command, args, { cwd: root, env: process.env, stdio: "inherit" });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
