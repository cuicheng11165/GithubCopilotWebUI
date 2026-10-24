import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertRepositoriesConfig, missingRepositoriesConfigMessage } from "../scripts/repositories-config.mjs";

describe("repository config startup", () => {
  it("explains how to copy the example when the local file is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repo-config-"));
    const expected = path.join(root, "config", "repositories.yaml");
    expect(() => assertRepositoriesConfig(root, {})).toThrow(missingRepositoriesConfigMessage(expected));
    try {
      assertRepositoriesConfig(root, {});
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("cp config/repositories.example.yaml config/repositories.yaml");
      expect((error as Error).message).toContain("Copy-Item config\\repositories.example.yaml config\\repositories.yaml");
    }
  });

  it("accepts a copied repositories.yaml", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "repo-config-"));
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, "repositories: []\n");
    expect(assertRepositoriesConfig(root, { REPOSITORIES_CONFIG: configPath })).toBe(configPath);
  });
});
