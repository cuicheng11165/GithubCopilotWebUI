import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRepositoryFile, scanSkills, type RepositoryConfig } from "./index.js";

describe("repository tools", () => {
  it("discovers skills by documented precedence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repo-tools-"));
    await mkdir(path.join(root, ".github/skills/review"), { recursive: true });
    await writeFile(path.join(root, ".github/skills/review/SKILL.md"), "---\nname: review\ndescription: Review code\n---\nDo it");
    const repository: RepositoryConfig = { id: "test", displayName: "Test", path: root, canonicalPath: root, enabled: true };
    const skills = await scanSkills(repository);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("review");
  });

  it("rejects parent traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repo-tools-"));
    const repository: RepositoryConfig = { id: "test", displayName: "Test", path: root, canonicalPath: root, enabled: true };
    await expect(readRepositoryFile(repository, "../secret")).rejects.toThrow("outside");
  });

  it("rejects symlinks that escape the repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repo-tools-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "repo-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const repository: RepositoryConfig = { id: "test", displayName: "Test", path: root, canonicalPath: root, enabled: true };
    await expect(readRepositoryFile(repository, "escape/secret.txt")).rejects.toThrow("escapes");
  });
});
