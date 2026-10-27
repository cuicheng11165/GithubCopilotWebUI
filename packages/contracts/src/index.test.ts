import { describe, expect, it } from "vitest";
import { approvalScopeSchema, eventKindSchema, permissionRequestSchema, shouldAutoApprove, turnStatusSchema } from "./index.js";

describe("approval policy", () => {
  it("never auto-approves interactive requests", () => expect(shouldAutoApprove("interactive", ["shell"], "shell")).toBe(false));
  it("only auto-approves selected session scopes", () => {
    expect(shouldAutoApprove("session-scoped", ["url"], "url")).toBe(true);
    expect(shouldAutoApprove("session-scoped", ["url"], "shell")).toBe(false);
  });
  it("auto-approves supported tools in allow-all", () => expect(shouldAutoApprove("allow-all", [], "private-script")).toBe(true));
  it("supports session-scoped MCP approval", () => expect(shouldAutoApprove("session-scoped", ["mcp"], "mcp")).toBe(true));
  it("keeps continue prompts out of session approval scopes", () => {
    expect(approvalScopeSchema.safeParse("continue").success).toBe(false);
    expect(permissionRequestSchema.shape.scope.safeParse("continue").success).toBe(true);
  });
  it("distinguishes timed-out and interrupted turns", () => {
    expect(turnStatusSchema.parse("timed-out")).toBe("timed-out");
    expect(turnStatusSchema.parse("interrupted")).toBe("interrupted");
    expect(eventKindSchema.parse("turn.timed_out")).toBe("turn.timed_out");
    expect(eventKindSchema.parse("turn.interrupted")).toBe("turn.interrupted");
  });
});
