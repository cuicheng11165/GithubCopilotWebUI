import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

export interface ExecutionResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

interface BaseExecutionInput {
  sessionId: string;
  command: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
}

export interface LocalExecutionInput extends BaseExecutionInput {
  repositoryPath: string;
  tempRoot: string;
}

export interface ContainerExecutionInput extends BaseExecutionInput {
  containerName: string;
  repositoryPath: string;
  runtime: "docker" | "podman";
  image: string;
  network: string;
  httpProxy?: string;
}

interface CaptureState {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function capture(state: CaptureState, target: "stdout" | "stderr", chunk: Buffer, maxOutputBytes: number) {
  const remaining = maxOutputBytes - Buffer.byteLength(state.stdout) - Buffer.byteLength(state.stderr);
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const value = chunk.subarray(0, remaining).toString("utf8");
  if (target === "stdout") state.stdout += value;
  else state.stderr += value;
  if (chunk.byteLength > remaining) state.truncated = true;
}

function terminateProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to terminating the direct child.
    }
  }
  child.kill("SIGKILL");
}

async function waitForChild(child: ChildProcess, state: CaptureState, timeoutSeconds: number, onTimeout: () => void): Promise<ExecutionResult> {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    onTimeout();
  }, timeoutSeconds * 1000);
  let exitCode: number | null = null;
  let signal: string | null = null;
  try {
    const [code, childSignal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    exitCode = code;
    signal = childSignal;
  } catch (error) {
    exitCode = 127;
    const message = error instanceof Error ? error.message : "Failed to start command";
    state.stderr += `${state.stderr ? "\n" : ""}${message}`;
  } finally {
    clearTimeout(timeout);
  }
  return { exitCode, signal, stdout: state.stdout, stderr: state.stderr, truncated: state.truncated, timedOut };
}

export class ExecutionManager {
  private readonly localProcesses = new Map<string, Set<ChildProcess>>();
  private readonly containers = new Map<string, Set<{ name: string; runtime: "docker" | "podman" }>>();

  async executeLocal(input: LocalExecutionInput): Promise<ExecutionResult> {
    await mkdir(input.tempRoot, { recursive: true });
    const tempDirectory = await mkdtemp(path.join(input.tempRoot, `${input.sessionId}-`));
    const processes = this.localProcesses.get(input.sessionId) ?? new Set<ChildProcess>();
    const child = spawn("/bin/sh", ["-lc", input.command], {
      cwd: input.repositoryPath,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: tempDirectory,
        TMPDIR: tempDirectory,
        TMP: tempDirectory,
        TEMP: tempDirectory,
        XDG_CACHE_HOME: path.join(tempDirectory, "cache"),
        LANG: process.env.LANG ?? "C.UTF-8"
      }
    });
    processes.add(child);
    this.localProcesses.set(input.sessionId, processes);
    const state: CaptureState = { stdout: "", stderr: "", truncated: false };
    child.stdout?.on("data", (chunk: Buffer) => capture(state, "stdout", chunk, input.maxOutputBytes));
    child.stderr?.on("data", (chunk: Buffer) => capture(state, "stderr", chunk, input.maxOutputBytes));
    try {
      return await waitForChild(child, state, input.timeoutSeconds, () => terminateProcess(child));
    } finally {
      processes.delete(child);
      if (processes.size === 0) this.localProcesses.delete(input.sessionId);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  async executeContainer(input: ContainerExecutionInput): Promise<ExecutionResult> {
    const containers = this.containers.get(input.sessionId) ?? new Set<{ name: string; runtime: "docker" | "podman" }>();
    const record = { name: input.containerName, runtime: input.runtime };
    containers.add(record);
    this.containers.set(input.sessionId, containers);
    const args = [
      "run", "--rm", "--name", input.containerName,
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      "--pids-limit=128", "--memory=1g", "--cpus=1.5",
      "--network", input.network,
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m",
      "--mount", `type=bind,src=${input.repositoryPath},dst=/repo,readonly`,
      "--workdir", "/repo", "--user", "65532:65532",
      "--env", "HOME=/tmp", "--env", "XDG_CACHE_HOME=/tmp/cache",
      ...(input.httpProxy ? ["--env", `HTTP_PROXY=${input.httpProxy}`, "--env", `HTTPS_PROXY=${input.httpProxy}`, "--env", `http_proxy=${input.httpProxy}`, "--env", `https_proxy=${input.httpProxy}`, "--env", "NO_PROXY=", "--env", "no_proxy="] : []),
      input.image, "/bin/sh", "-lc", input.command
    ];
    const child = spawn(input.runtime, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
    const state: CaptureState = { stdout: "", stderr: "", truncated: false };
    child.stdout?.on("data", (chunk: Buffer) => capture(state, "stdout", chunk, input.maxOutputBytes));
    child.stderr?.on("data", (chunk: Buffer) => capture(state, "stderr", chunk, input.maxOutputBytes));
    const removeContainer = () => {
      const cleanup = spawn(input.runtime, ["rm", "-f", input.containerName], { stdio: "ignore", env: { PATH: process.env.PATH } });
      cleanup.unref();
    };
    try {
      return await waitForChild(child, state, input.timeoutSeconds, removeContainer);
    } finally {
      containers.delete(record);
      if (containers.size === 0) this.containers.delete(input.sessionId);
    }
  }

  async stop(sessionId: string): Promise<number> {
    const processes = [...(this.localProcesses.get(sessionId) ?? [])];
    const containers = [...(this.containers.get(sessionId) ?? [])];
    await Promise.all(processes.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit").catch(() => undefined);
      terminateProcess(child);
      await exited;
    }));
    await Promise.all(containers.map(async ({ name, runtime }) => {
      const child = spawn(runtime, ["rm", "-f", name], { stdio: "ignore", env: { PATH: process.env.PATH } });
      await once(child, "exit").catch(() => undefined);
    }));
    this.localProcesses.delete(sessionId);
    this.containers.delete(sessionId);
    return processes.length + containers.length;
  }
}
