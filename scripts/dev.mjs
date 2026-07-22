import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

for (const name of ["REPOSITORIES_CONFIG", "COPILOT_HOME"]) {
  const value = process.env[name];
  if (value?.startsWith("./")) process.env[name] = path.resolve(root, value);
}

const pnpmCli = process.env.npm_execpath;
const command = pnpmCli ? process.execPath : "pnpm";
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
