import { describe, expect, it } from "vitest";
import { parseToolResult } from "./tool-result.js";

describe("parseToolResult", () => {
  it("extracts readable stdout from a nested command result", () => {
    const content = JSON.stringify({
      toolCallId: "internal-id",
      success: true,
      result: {
        content: JSON.stringify({
          exitCode: 0,
          signal: null,
          stdout: "1.0.8\n",
          stderr: "",
          truncated: false,
          timedOut: false
        })
      }
    });

    expect(parseToolResult(content)).toMatchObject({
      status: "success",
      title: "Command completed",
      summary: "1.0.8"
    });
  });

  it("surfaces stderr when a command fails", () => {
    const content = JSON.stringify({
      success: true,
      result: {
        content: JSON.stringify({
          exitCode: 1,
          stdout: "",
          stderr: "Package not found",
          timedOut: false
        })
      }
    });

    expect(parseToolResult(content)).toMatchObject({
      status: "error",
      title: "Command failed",
      summary: "Package not found"
    });
  });

  it("handles plain text tool output", () => {
    expect(parseToolResult("Repository indexed")).toMatchObject({
      status: "success",
      title: "Tool completed",
      summary: "Repository indexed"
    });
  });

  it("extracts plain text from result content", () => {
    const content = JSON.stringify({
      success: true,
      result: { content: "Repository indexed" }
    });

    expect(parseToolResult(content)).toMatchObject({
      status: "success",
      title: "Tool completed",
      summary: "Repository indexed"
    });
  });

  it("keeps internal metadata in technical details", () => {
    const result = parseToolResult(JSON.stringify({ success: true, toolCallId: "call-123" }));

    expect(result.summary).toBe("Completed successfully.");
    expect(result.detail).toContain('"toolCallId": "call-123"');
  });
});
