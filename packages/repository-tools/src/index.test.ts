import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { globRepositoryFiles, readRepositoryFile, scanSkills, searchRepository, viewRepositoryFile, type RepositoryConfig } from "./index.js";

describe("repository tools", () => {
  it("discovers skills by documented precedence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repo-tools-"));
    await mkdir(path.join(root, ".github/skills/review"), { recursive: true });
    await writeFile(path.join(root, ".github/skills/review/SKILL.md"), "---\nname: review\ndescription: Review code\n---\nDo it");
    const repository: RepositoryConfig = { id: "test", displayName: "Test", path: root, canonicalPath: await realpath(root), enabled: true };
    const skills = await scanSkills(repository);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("review");
  });

  it("rejects parent traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repo-tools-"));
    const repository: RepositoryConfig = { id: "test", displayName: "Test", path: root, canonicalPath: await realpath(root), enabled: true };
    await expect(readRepositoryFile(repository, "../secret")).rejects.toThrow("outside");
  });

  it("rejects symlinks that escape the repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repo-tools-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "repo-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const repository: RepositoryConfig = { id: "test", displayName: "Test", path: root, canonicalPath: await realpath(root), enabled: true };
    await expect(readRepositoryFile(repository, "escape/secret.txt")).rejects.toThrow("escapes");
  });

  it("views numbered line ranges and finds files by glob", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repo-tools-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/example.ts"), "first\nsecond\nthird\n");
    await writeFile(path.join(root, "src/example.test.ts"), "test\n");
    const repository: RepositoryConfig = { id: "test", displayName: "Test", path: root, canonicalPath: await realpath(root), enabled: true };

    const view = await viewRepositoryFile(repository, "src/example.ts", 2, 2);
    expect(view.content).toContain("2\tsecond");
    expect(view.content).toContain("3\tthird");
    expect(await globRepositoryFiles(repository, "**/*.test.ts")).toEqual(["src/example.test.ts"]);
  });

  it("falls back to Node file matching and search when ripgrep is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repo-tools-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/example.ts"), "const windowsFallback = true;\n");
    const repository: RepositoryConfig = { id: "test", displayName: "Test", path: root, canonicalPath: await realpath(root), enabled: true };
    vi.stubEnv("PATH", "");
    try {
      expect(await globRepositoryFiles(repository, "**/*.ts")).toEqual(["src/example.ts"]);
      expect(await searchRepository(repository, "windowsFallback")).toContain("src/example.ts:1:7");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
