import { spawn } from "node:child_process";

async function runGitApply(repositoryPath: string, patch: string, check: boolean): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["apply", "--whitespace=nowarn", ...(check ? ["--check"] : []), "-"];
    const child = spawn("git", args, {
      cwd: repositoryPath,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < 128_000) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 128_000) stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(stderr.trim() || `git apply exited with code ${code}`));
    });
    child.stdin.end(patch);
  });
}

export async function applyRepositoryPatch(repositoryPath: string, patch: string) {
  if (Buffer.byteLength(patch) > 512_000) throw new Error("Patch exceeds the 512000 byte limit");
  if (!patch.includes("diff --git ") && !patch.includes("*** Begin Patch")) {
    throw new Error("Patch must use unified git diff format");
  }
  if (patch.includes("*** Begin Patch")) {
    throw new Error("Codex patch envelopes are not supported; provide the unified git diff inside the envelope");
  }
  await runGitApply(repositoryPath, patch, true);
  const result = await runGitApply(repositoryPath, patch, false);
  return { applied: true, stdout: result.stdout, stderr: result.stderr };
}
