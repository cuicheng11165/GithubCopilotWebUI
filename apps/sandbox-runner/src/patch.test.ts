import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { applyRepositoryPatch } from "./patch.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("applyRepositoryPatch", () => {
  it("validates and applies a unified git diff", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "copilotdeck-patch-"));
    temporaryDirectories.push(root);
    await execFileAsync("git", ["init"], { cwd: root });
    await writeFile(path.join(root, "example.txt"), "before\n");
    const patch = [
      "diff --git a/example.txt b/example.txt",
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      ""
    ].join("\n");

    await expect(applyRepositoryPatch(root, patch)).resolves.toMatchObject({ applied: true });
    expect(await readFile(path.join(root, "example.txt"), "utf8")).toBe("after\n");
  });

  it("rejects non-diff input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "copilotdeck-patch-"));
    temporaryDirectories.push(root);
    await expect(applyRepositoryPatch(root, "replace everything")).rejects.toThrow("unified git diff");
  });
});
