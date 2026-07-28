import { describe, expect, it } from "vitest";
import { resolvePythonLauncher } from "./platform.js";

describe("resolvePythonLauncher", () => {
  it("uses python3 on Unix platforms", async () => {
    await expect(resolvePythonLauncher("linux")).resolves.toEqual({
      executable: "python3",
      prefixArgs: [],
      shellPrefix: "python3"
    });
  });

  it("prefers a PATH Python installation on Windows", async () => {
    await expect(resolvePythonLauncher("win32", async (command) => command === "python.exe")).resolves.toEqual({
      executable: "python",
      prefixArgs: [],
      shellPrefix: "python"
    });
  });

  it("falls back to the Windows py launcher", async () => {
    await expect(resolvePythonLauncher("win32", async (command) => command === "py.exe")).resolves.toEqual({
      executable: "py",
      prefixArgs: ["-3"],
      shellPrefix: "py -3"
    });
  });
});
