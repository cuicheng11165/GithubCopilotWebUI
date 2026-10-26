import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { redactSecretText } from "@app/contracts";

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
  timeout: NodeJS.Timeout | undefined;
  clearTimeout: () => void;
  tempDirectory: string;
  secrets: string[];
  closeHook: () => Promise<void>;
}

export interface CommandDeadline {
  pause(): void;
  resume(): void;
  remainingMs(): number;
  readonly paused: boolean;
}

export function createCommandDeadline(timeoutMs: number, now: () => number = Date.now): CommandDeadline {
  const started = now();
  let paused = false;
  let pausedAt = 0;
  let accumulated = 0;
  return {
    pause() {
      if (paused) return;
      paused = true;
      pausedAt = now();
    },
    resume() {
      if (!paused) return;
      accumulated += now() - pausedAt;
      paused = false;
    },
    remainingMs() {
      const at = now();
      const live = paused ? at - pausedAt : 0;
      return timeoutMs - (at - started - accumulated - live);
    },
    get paused() { return paused; }
  };
}

export interface ExecutionControls {
  pauseTimeout(): void;
  resumeTimeout(): void;
  redact(secrets: readonly string[]): void;
}

export interface SecureFormHookAttachment {
  env: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

export interface SecureFormBridge {
  attach(input: {
    sessionId: string;
    tempDirectory: string;
    repositoryPath: string;
    timeoutSeconds: number;
    maxOutputBytes: number;
    controls: ExecutionControls;
  }): Promise<SecureFormHookAttachment>;
}

export interface StdinExecution {
  write(text: string): void;
  end(): void;
  cancel(): void;
  pauseTimeout(): void;
  resumeTimeout(): void;
  addSecrets(secrets: readonly string[]): void;
  finished: Promise<ExecutionResult>;
}

function withRedaction<T extends ExecutionResult>(result: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return result;
  return { ...result, stdout: redactSecretText(result.stdout, secrets), stderr: redactSecretText(result.stderr, secrets) };
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
  private bridge: SecureFormBridge | undefined;

  constructor(bridge?: SecureFormBridge) {
    this.bridge = bridge;
  }

  setBridge(bridge: SecureFormBridge) {
    this.bridge = bridge;
  }

  private spawnChild(input: ExecutionInput, tempDirectory: string, stdio: "ignore" | "pipe", extraEnv?: NodeJS.ProcessEnv): ChildProcess {
    const invocation = input.executable
      ? { executable: input.executable, args: input.args ?? [] }
      : localShellCommand(input.command);
    return spawn(invocation.executable, invocation.args, {
      cwd: input.repositoryPath,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [stdio, "pipe", "pipe"],
      env: { ...restrictedExecutionEnvironment(tempDirectory), ...(extraEnv ?? {}) }
    });
  }

  private async attachHook(input: ExecutionInput, tempDirectory: string, controls: ExecutionControls): Promise<SecureFormHookAttachment | undefined> {
    if (!this.bridge) return undefined;
    return this.bridge.attach({
      sessionId: input.sessionId,
      tempDirectory,
      repositoryPath: input.repositoryPath,
      timeoutSeconds: input.timeoutSeconds,
      maxOutputBytes: input.maxOutputBytes,
      controls
    });
  }

  async execute(input: ExecutionInput): Promise<ExecutionResult> {
    await mkdir(input.tempRoot, { recursive: true });
    const tempDirectory = await mkdtemp(path.join(input.tempRoot, `${input.sessionId}-`));
    const processes = this.processes.get(input.sessionId) ?? new Set<ChildProcess>();
    const secrets: string[] = [];
    const deadline = this.bridge ? createCommandDeadline(input.timeoutSeconds * 1000) : undefined;
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const arm = () => {
      if (!deadline || !child) return;
      if (timer) clearTimeout(timer);
      if (deadline.paused || child.exitCode !== null || child.signalCode !== null) return;
      const left = deadline.remainingMs();
      if (left <= 0) {
        timedOut = true;
        terminateProcess(child);
        return;
      }
      timer = setTimeout(() => {
        if (!child || deadline.paused) return;
        timedOut = true;
        terminateProcess(child);
      }, left);
    };
    const controls: ExecutionControls = {
      pauseTimeout() {
        deadline?.pause();
        if (timer) clearTimeout(timer);
      },
      resumeTimeout() {
        deadline?.resume();
        arm();
      },
      redact(values) { secrets.push(...values); }
    };
    let hook: SecureFormHookAttachment | undefined;
    try {
      hook = await this.attachHook(input, tempDirectory, controls);
      child = this.spawnChild(input, tempDirectory, "ignore", hook?.env);
      const spawned = child;
      processes.add(spawned);
      this.processes.set(input.sessionId, processes);
      const state: CaptureState = { stdout: "", stderr: "", truncated: false };
      spawned.stdout?.on("data", (chunk: Buffer) => capture(state, "stdout", chunk, input.maxOutputBytes));
      spawned.stderr?.on("data", (chunk: Buffer) => capture(state, "stderr", chunk, input.maxOutputBytes));
      const result = deadline
        ? await this.waitWithDeadline(spawned, state, () => { arm(); })
        : await waitForChild(spawned, state, input.timeoutSeconds, () => terminateProcess(spawned));
      if (deadline) result.timedOut = timedOut || result.timedOut;
      return withRedaction(result, secrets);
    } finally {
      if (timer) clearTimeout(timer);
      if (child) processes.delete(child);
      if (processes.size === 0) this.processes.delete(input.sessionId);
      await hook?.close().catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  private async waitWithDeadline(child: ChildProcess, state: CaptureState, arm: () => void): Promise<ExecutionResult> {
    arm();
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
    }
    return { exitCode, signal, stdout: state.stdout, stderr: state.stderr, truncated: state.truncated, timedOut: false };
  }

  async start(input: ExecutionInput, settleMilliseconds = 500): Promise<BackgroundExecutionResult> {
    await mkdir(input.tempRoot, { recursive: true });
    const tempDirectory = await mkdtemp(path.join(input.tempRoot, `${input.sessionId}-`));
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
    const secrets: string[] = [];
    const deadline = this.bridge ? createCommandDeadline(input.timeoutSeconds * 1000) : undefined;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    const arm = () => {
      if (!deadline || !child) return;
      if (timer) clearTimeout(timer);
      if (deadline.paused || child.exitCode !== null || child.signalCode !== null) return;
      const left = deadline.remainingMs();
      if (left <= 0) {
        result.timedOut = true;
        terminateProcess(child);
        return;
      }
      timer = setTimeout(() => {
        if (!child || deadline.paused || child.exitCode !== null || child.signalCode !== null) return;
        result.timedOut = true;
        terminateProcess(child);
      }, left);
    };
    const controls: ExecutionControls = {
      pauseTimeout() {
        deadline?.pause();
        if (timer) clearTimeout(timer);
      },
      resumeTimeout() {
        deadline?.resume();
        arm();
      },
      redact(values) { secrets.push(...values); }
    };
    let hook: SecureFormHookAttachment | undefined;
    try {
      hook = await this.attachHook(input, tempDirectory, controls);
      child = this.spawnChild(input, tempDirectory, "ignore", hook?.env);
    } catch (error) {
      await hook?.close().catch(() => undefined);
      await rm(tempDirectory, { recursive: true, force: true });
      throw error;
    }
    const processes = this.processes.get(input.sessionId) ?? new Set<ChildProcess>();
    processes.add(child);
    this.processes.set(input.sessionId, processes);
    child.stdout?.on("data", (chunk: Buffer) => capture(state, "stdout", chunk, input.maxOutputBytes));
    child.stderr?.on("data", (chunk: Buffer) => capture(state, "stderr", chunk, input.maxOutputBytes));
    if (!deadline) {
      timer = setTimeout(() => {
        result.timedOut = true;
        terminateProcess(child!);
      }, input.timeoutSeconds * 1000);
    } else arm();
    const execution: BackgroundExecution = {
      sessionId: input.sessionId,
      child,
      state,
      result,
      timeout: timer,
      clearTimeout: () => { if (timer) clearTimeout(timer); },
      tempDirectory,
      secrets,
      closeHook: async () => { await hook?.close().catch(() => undefined); }
    };
    this.background.set(bashId, execution);
    child.once("error", (error) => {
      state.stderr += `${state.stderr ? "\n" : ""}${error.message}`;
    });
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      processes.delete(child!);
      if (processes.size === 0) this.processes.delete(input.sessionId);
      result.exitCode = code;
      result.signal = signal;
      result.status = result.timedOut || code !== 0 ? "failed" : "completed";
      result.completedAt = new Date().toISOString();
      void execution.closeHook().finally(() => { void rm(tempDirectory, { recursive: true, force: true }); });
    });
    await Promise.race([
      once(child, "exit").catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, settleMilliseconds))
    ]);
    return this.snapshot(execution);
  }

  beginStdin(input: ExecutionInput): StdinExecution {
    const secrets: string[] = [];
    const state: CaptureState = { stdout: "", stderr: "", truncated: false };
    const tempDirectoryPromise = mkdir(input.tempRoot, { recursive: true }).then(() => mkdtemp(path.join(input.tempRoot, `${input.sessionId}-`)));
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const deadline = createCommandDeadline(input.timeoutSeconds * 1000);
    const arm = () => {
      if (!child) return;
      if (timer) clearTimeout(timer);
      if (deadline.paused || child.exitCode !== null || child.signalCode !== null) return;
      const left = deadline.remainingMs();
      if (left <= 0) {
        timedOut = true;
        terminateProcess(child);
        return;
      }
      timer = setTimeout(() => {
        if (!child || deadline.paused) return;
        timedOut = true;
        terminateProcess(child);
      }, left);
    };
    const ready = tempDirectoryPromise.then((tempDirectory) => {
      child = this.spawnChild(input, tempDirectory, "pipe");
      const processes = this.processes.get(input.sessionId) ?? new Set<ChildProcess>();
      processes.add(child);
      this.processes.set(input.sessionId, processes);
      child.stdout?.on("data", (chunk: Buffer) => capture(state, "stdout", chunk, input.maxOutputBytes));
      child.stderr?.on("data", (chunk: Buffer) => capture(state, "stderr", chunk, input.maxOutputBytes));
      child.once("error", (error) => {
        state.stderr += `${state.stderr ? "\n" : ""}${error.message}`;
      });
      child.once("exit", () => {
        if (timer) clearTimeout(timer);
        processes.delete(child!);
        if (processes.size === 0) this.processes.delete(input.sessionId);
        void rm(tempDirectory, { recursive: true, force: true });
      });
      arm();
      return child;
    });
    const finished = ready.then(async (spawned) => {
      let exitCode: number | null = null;
      let signal: string | null = null;
      try {
        const [code, childSignal] = await once(spawned, "exit") as [number | null, NodeJS.Signals | null];
        exitCode = code;
        signal = childSignal;
      } catch (error) {
        exitCode = 127;
        const message = error instanceof Error ? error.message : "Failed to start command";
        state.stderr += `${state.stderr ? "\n" : ""}${message}`;
      }
      return withRedaction({ exitCode, signal, stdout: state.stdout, stderr: state.stderr, truncated: state.truncated, timedOut }, secrets);
    });
    return {
      write(text) { void ready.then((spawned) => { spawned.stdin?.write(text); }).catch(() => undefined); },
      end() { void ready.then((spawned) => { spawned.stdin?.end(); }).catch(() => undefined); },
      cancel() { void ready.then((spawned) => terminateProcess(spawned)).catch(() => undefined); },
      pauseTimeout() { deadline.pause(); if (timer) clearTimeout(timer); },
      resumeTimeout() { deadline.resume(); arm(); },
      addSecrets(values) { secrets.push(...values); },
      finished
    };
  }

  async runWithStdin(input: ExecutionInput & { stdin: string; secrets?: readonly string[] }): Promise<ExecutionResult> {
    const execution = this.beginStdin(input);
    if (input.secrets) execution.addSecrets(input.secrets);
    execution.write(input.stdin);
    execution.end();
    return execution.finished;
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
    return withRedaction({
      ...execution.result,
      stdout: execution.state.stdout,
      stderr: execution.state.stderr,
      truncated: execution.state.truncated
    }, execution.secrets);
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
