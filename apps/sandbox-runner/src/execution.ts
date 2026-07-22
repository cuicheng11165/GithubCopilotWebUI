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

export interface ExecutionInput extends BaseExecutionInput {
  repositoryPath: string;
  tempRoot: string;
  executable?: string;
  args?: string[];
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
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.once("error", () => child.kill("SIGKILL"));
    killer.once("exit", (code) => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    return;
  }
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

export function localShellCommand(command: string, platform = process.platform, environment = process.env) {
  if (platform === "win32") {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command]
    };
  }
  return { executable: "/bin/sh", args: ["-lc", command] };
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
  private readonly processes = new Map<string, Set<ChildProcess>>();

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    await mkdir(input.tempRoot, { recursive: true });
    const tempDirectory = await mkdtemp(path.join(input.tempRoot, `${input.sessionId}-`));
    const processes = this.processes.get(input.sessionId) ?? new Set<ChildProcess>();
    const invocation = input.executable
      ? { executable: input.executable, args: input.args ?? [] }
      : localShellCommand(input.command);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: input.repositoryPath,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? (process.platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/local/bin:/usr/bin:/bin"),
        HOME: tempDirectory,
        TMPDIR: tempDirectory,
        TMP: tempDirectory,
        TEMP: tempDirectory,
        XDG_CACHE_HOME: path.join(tempDirectory, "cache"),
        LANG: process.env.LANG ?? "C.UTF-8",
        ...(process.platform === "win32" ? {
          ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? "C:\\Windows",
          PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"
        } : {})
      }
    });
    processes.add(child);
    this.processes.set(input.sessionId, processes);
    const state: CaptureState = { stdout: "", stderr: "", truncated: false };
    child.stdout?.on("data", (chunk: Buffer) => capture(state, "stdout", chunk, input.maxOutputBytes));
    child.stderr?.on("data", (chunk: Buffer) => capture(state, "stderr", chunk, input.maxOutputBytes));
    try {
      return await waitForChild(child, state, input.timeoutSeconds, () => terminateProcess(child));
    } finally {
      processes.delete(child);
      if (processes.size === 0) this.processes.delete(input.sessionId);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  async stop(sessionId: string): Promise<number> {
    const processes = [...(this.processes.get(sessionId) ?? [])];
    await Promise.all(processes.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit").catch(() => undefined);
      terminateProcess(child);
      await exited;
    }));
    this.processes.delete(sessionId);
    return processes.length;
  }
}
