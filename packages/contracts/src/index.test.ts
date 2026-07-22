import { describe, expect, it } from "vitest";
import { shouldAutoApprove } from "./index.js";

describe("approval policy", () => {
  it("never auto-approves interactive requests", () => expect(shouldAutoApprove("interactive", ["shell"], "shell")).toBe(false));
  it("only auto-approves selected session scopes", () => {
    expect(shouldAutoApprove("session-scoped", ["url"], "url")).toBe(true);
    expect(shouldAutoApprove("session-scoped", ["url"], "shell")).toBe(false);
  });
  it("auto-approves supported tools in allow-all", () => expect(shouldAutoApprove("allow-all", [], "private-script")).toBe(true));
});
