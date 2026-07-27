import { describe, expect, it } from "vitest";
import { sanitizeToolEventForLog } from "./tool-event-log.js";

describe("sanitizeToolEventForLog", () => {
  it("preserves tool identity, arguments, and execution results", () => {
    expect(sanitizeToolEventForLog({
      toolName: "shell",
      arguments: { command: "git status" },
      result: { exitCode: 0, stdout: "clean", stderr: "" }
    })).toEqual({
      toolName: "shell",
      arguments: { command: "git status" },
      result: { exitCode: 0, stdout: "clean", stderr: "" }
    });
  });

  it("redacts sensitive keyed values recursively", () => {
    expect(sanitizeToolEventForLog({
      arguments: {
        authorization: "Bearer secret",
        nested: { accessToken: "secret-token", password: "secret-password" }
      }
    })).toEqual({
      arguments: {
        authorization: "[Redacted]",
        nested: { accessToken: "[Redacted]", password: "[Redacted]" }
      }
    });
  });

  it("truncates exceptionally large string fields in log output", () => {
    const output = "x".repeat(70 * 1024);
    const sanitized = sanitizeToolEventForLog({ result: { stdout: output } });
    const stdout = (sanitized.result as { stdout: string }).stdout;

    expect(stdout.length).toBeLessThan(output.length);
    expect(stdout).toContain("[truncated in log]");
  });
});
