import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionManager, localShellCommand } from "./execution.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ExecutionManager local backend", () => {
  it("selects the native command shell for Windows and Unix", () => {
    expect(localShellCommand("echo ok", "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "echo ok"]
    });
    expect(localShellCommand("echo ok", "linux", {})).toEqual({ executable: "/bin/sh", args: ["-lc", "echo ok"] });
  });

  it("runs commands in the repository with a restricted environment", async () => {
    const repositoryPath = await temporaryDirectory("copilotdeck-repository-");
    const tempRoot = await temporaryDirectory("copilotdeck-execution-");
    const manager = new ExecutionManager();

    const result = await manager.executeLocal({
      sessionId: "11111111-1111-4111-8111-111111111111",
      command: "node -e \"console.log(process.cwd()); console.log(process.env.HOME)\"",
      repositoryPath,
      tempRoot,
      timeoutSeconds: 2,
      maxOutputBytes: 4096
    });

    const [workingDirectory, home] = result.stdout.trim().split("\n");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(workingDirectory).toBe(await realpath(repositoryPath));
    expect(home?.startsWith(tempRoot) || home?.startsWith(await realpath(tempRoot))).toBe(true);
    expect(home).not.toBe(process.env.HOME);
  });

  it("enforces output and timeout limits", async () => {
    const repositoryPath = await temporaryDirectory("copilotdeck-repository-");
    const tempRoot = await temporaryDirectory("copilotdeck-execution-");
    const manager = new ExecutionManager();

    const truncated = await manager.executeLocal({
      sessionId: "22222222-2222-4222-8222-222222222222",
      command: "node -e \"process.stdout.write('1234567890')\"",
      repositoryPath,
      tempRoot,
      timeoutSeconds: 2,
      maxOutputBytes: 5
    });
    const combined = await manager.executeLocal({
      sessionId: "66666666-6666-4666-8666-666666666666",
      command: "node -e \"process.stdout.write('1234'); process.stderr.write('5678')\"",
      repositoryPath,
      tempRoot,
      timeoutSeconds: 2,
      maxOutputBytes: 5
    });
    const timedOut = await manager.executeLocal({
      sessionId: "33333333-3333-4333-8333-333333333333",
      command: "node -e \"setTimeout(() => {}, 5000)\"",
      repositoryPath,
      tempRoot,
      timeoutSeconds: 0.05,
      maxOutputBytes: 4096
    });

    expect(truncated.stdout).toBe("12345");
    expect(truncated.truncated).toBe(true);
    expect(Buffer.byteLength(combined.stdout) + Buffer.byteLength(combined.stderr)).toBe(5);
    expect(combined.truncated).toBe(true);
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.signal === "SIGKILL" || timedOut.exitCode !== 0).toBe(true);
  });

  it("runs repository-relative scripts and permits local repository changes", async () => {
    const repositoryPath = await temporaryDirectory("copilotdeck-repository-");
    const tempRoot = await temporaryDirectory("copilotdeck-execution-");
    const manager = new ExecutionManager();
    const script = path.join(repositoryPath, "private-script.cjs");
    await writeFile(script, "require('node:fs').writeFileSync('generated.txt', process.argv[2])\n");

    const result = await manager.executeLocal({
      sessionId: "55555555-5555-4555-8555-555555555555",
      command: "Run private script",
      executable: process.execPath,
      args: [script, "local-result"],
      repositoryPath,
      tempRoot,
      timeoutSeconds: 2,
      maxOutputBytes: 4096
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(repositoryPath, "generated.txt"), "utf8")).toBe("local-result");
  });

  it("stops all active processes for a session", async () => {
    const repositoryPath = await temporaryDirectory("copilotdeck-repository-");
    const tempRoot = await temporaryDirectory("copilotdeck-execution-");
    const manager = new ExecutionManager();
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const execution = manager.executeLocal({
      sessionId,
      command: "node -e \"setTimeout(() => {}, 5000)\"",
      repositoryPath,
      tempRoot,
      timeoutSeconds: 10,
      maxOutputBytes: 4096
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await manager.stop(sessionId)).toBe(1);
    const result = await execution;
    expect(result.signal === "SIGKILL" || result.exitCode !== 0).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});
