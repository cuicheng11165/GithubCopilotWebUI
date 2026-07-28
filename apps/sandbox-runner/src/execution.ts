import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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

export interface BackgroundExecutionResult extends ExecutionResult {
  bashId: string;
  command: string;
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: string;
  completedAt: string | null;
}

interface BackgroundExecution {
  sessionId: string;
  child: ChildProcess;
  state: CaptureState;
  result: BackgroundExecutionResult;
  timeout: NodeJS.Timeout;
  tempDirectory: string;
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

export function restrictedExecutionEnvironment(
  tempDirectory: string,
  platform = process.platform,
  environment = process.env
): NodeJS.ProcessEnv {
  const base = {
    PATH: environment.PATH ?? (platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/local/bin:/usr/bin:/bin"),
    HOME: tempDirectory,
    TMPDIR: tempDirectory,
    TMP: tempDirectory,
    TEMP: tempDirectory,
    XDG_CACHE_HOME: path.join(tempDirectory, "cache"),
    LANG: environment.LANG ?? "C.UTF-8"
  };
  if (platform !== "win32") return base;
  const parsed = path.win32.parse(tempDirectory);
  return {
    ...base,
    USERPROFILE: tempDirectory,
    HOMEDRIVE: parsed.root.replace(/[\\/]$/, "") || environment.SystemDrive || "C:",
    HOMEPATH: parsed.root ? tempDirectory.slice(parsed.root.length - 1) : tempDirectory,
    APPDATA: path.win32.join(tempDirectory, "AppData", "Roaming"),
    LOCALAPPDATA: path.win32.join(tempDirectory, "AppData", "Local"),
    ComSpec: environment.ComSpec ?? environment.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe",
    SystemDrive: environment.SystemDrive ?? "C:",
    SystemRoot: environment.SystemRoot ?? "C:\\Windows",
    WINDIR: environment.WINDIR ?? environment.SystemRoot ?? "C:\\Windows",
    PATHEXT: environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    ...(environment.ProgramData ? { ProgramData: environment.ProgramData } : {}),
    ...(environment.ProgramFiles ? { ProgramFiles: environment.ProgramFiles } : {}),
    ...(environment["ProgramFiles(x86)"] ? { "ProgramFiles(x86)": environment["ProgramFiles(x86)"] } : {})
  };
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
  private readonly background = new Map<string, BackgroundExecution>();

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
      env: restrictedExecutionEnvironment(tempDirectory)
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

  async start(input: ExecutionInput, settleMilliseconds = 500): Promise<BackgroundExecutionResult> {
    await mkdir(input.tempRoot, { recursive: true });
    const tempDirectory = await mkdtemp(path.join(input.tempRoot, `${input.sessionId}-`));
    const invocation = input.executable
      ? { executable: input.executable, args: input.args ?? [] }
      : localShellCommand(input.command);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: input.repositoryPath,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: restrictedExecutionEnvironment(tempDirectory)
    });
    const bashId = randomUUID();
    const state: CaptureState = { stdout: "", stderr: "", truncated: false };
    const result: BackgroundExecutionResult = {
      bashId,
      command: input.command,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false
    };
    const processes = this.processes.get(input.sessionId) ?? new Set<ChildProcess>();
    processes.add(child);
    this.processes.set(input.sessionId, processes);
    child.stdout?.on("data", (chunk: Buffer) => capture(state, "stdout", chunk, input.maxOutputBytes));
    child.stderr?.on("data", (chunk: Buffer) => capture(state, "stderr", chunk, input.maxOutputBytes));
    const timeout = setTimeout(() => {
      result.timedOut = true;
      terminateProcess(child);
    }, input.timeoutSeconds * 1000);
    const execution: BackgroundExecution = { sessionId: input.sessionId, child, state, result, timeout, tempDirectory };
    this.background.set(bashId, execution);
    child.once("error", (error) => {
      state.stderr += `${state.stderr ? "\n" : ""}${error.message}`;
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      processes.delete(child);
      if (processes.size === 0) this.processes.delete(input.sessionId);
      result.exitCode = code;
      result.signal = signal;
      result.status = result.timedOut || code !== 0 ? "failed" : "completed";
      result.completedAt = new Date().toISOString();
      void rm(tempDirectory, { recursive: true, force: true });
    });
    await Promise.race([
      once(child, "exit").catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, settleMilliseconds))
    ]);
    return this.snapshot(execution);
  }

  read(sessionId: string, bashId: string, tailLines?: number): BackgroundExecutionResult {
    const execution = this.background.get(bashId);
    if (!execution || execution.sessionId !== sessionId) throw new Error("Bash execution not found");
    const snapshot = this.snapshot(execution);
    if (tailLines !== undefined) {
      snapshot.stdout = snapshot.stdout.split(/\r?\n/).slice(-tailLines).join("\n");
      snapshot.stderr = snapshot.stderr.split(/\r?\n/).slice(-tailLines).join("\n");
    }
    return snapshot;
  }

  list(sessionId: string): BackgroundExecutionResult[] {
    return [...this.background.values()]
      .filter((execution) => execution.sessionId === sessionId)
      .map((execution) => this.snapshot(execution))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, 100);
  }

  async stopOne(sessionId: string, bashId: string): Promise<BackgroundExecutionResult> {
    const execution = this.background.get(bashId);
    if (!execution || execution.sessionId !== sessionId) throw new Error("Bash execution not found");
    if (execution.child.exitCode === null && execution.child.signalCode === null) {
      const exited = once(execution.child, "exit").catch(() => undefined);
      execution.result.status = "stopped";
      terminateProcess(execution.child);
      await exited;
      execution.result.status = "stopped";
    }
    return this.snapshot(execution);
  }

  private snapshot(execution: BackgroundExecution): BackgroundExecutionResult {
    return {
      ...execution.result,
      stdout: execution.state.stdout,
      stderr: execution.state.stderr,
      truncated: execution.state.truncated
    };
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
    for (const execution of this.background.values()) {
      if (execution.sessionId === sessionId && execution.result.status === "running") execution.result.status = "stopped";
    }
    return processes.length;
  }
}
