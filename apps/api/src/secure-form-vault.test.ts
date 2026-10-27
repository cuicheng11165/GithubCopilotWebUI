import { describe, expect, it, vi } from "vitest";
import { SecureFormVault } from "./secure-form-vault.js";

describe("SecureFormVault", () => {
  it("returns each step once and wipes it afterwards", () => {
    const vault = new SecureFormVault();
    const expiresAt = Date.now() + 60_000;
    vault.putStep("form", "account", { email: "ada@example.com" }, expiresAt);
    vault.putStep("form", "secret", { password: "hunter2" }, expiresAt);
    expect(vault.claimStep("form", "account")).toEqual({ email: "ada@example.com" });
    expect(vault.claimStep("form", "account")).toBeNull();
    expect(vault.claimAll("form", ["account", "secret"])).toBeNull();
    expect(vault.claimAll("form", ["secret"])).toEqual(new Map([["secret", { password: "hunter2" }]]));
    expect(vault.claimAll("form", ["secret"])).toBeNull();
    expect(vault.has("form")).toBe(false);
  });

  it("drops expired values without returning them", () => {
    vi.useFakeTimers();
    try {
      const vault = new SecureFormVault();
      vault.putStep("form", "secret", { password: "hunter2" }, Date.now() + 1_000);
      vi.advanceTimersByTime(1_001);
      expect(vault.claimStep("form", "secret")).toBeNull();
      expect(vault.has("form")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards every buffered step for a form", () => {
    const vault = new SecureFormVault();
    const expiresAt = Date.now() + 60_000;
    vault.putStep("form", "account", { email: "ada@example.com" }, expiresAt);
    vault.putStep("other", "secret", { password: "hunter2" }, expiresAt);
    expect(vault.discardMany(["form", "missing"])).toBe(1);
    expect(vault.claimStep("form", "account")).toBeNull();
    expect(vault.claimStep("other", "secret")).toEqual({ password: "hunter2" });
  });
});
