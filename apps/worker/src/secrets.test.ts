import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./secrets.js";

describe("worker secret encryption", () => {
  it("round-trips tokens with a strict 32-byte key", () => {
    const secret = randomBytes(32).toString("base64");
    const encrypted = encryptSecret(secret, "gho_access");
    expect(decryptSecret(secret, encrypted)).toBe("gho_access");
    expect(() => decryptSecret(randomBytes(32).toString("base64"), encrypted)).toThrow();
    expect(() => encryptSecret("replace-with-base64-encoded-32-byte-key", "gho_access")).toThrow(/placeholder/);
    expect(() => encryptSecret("not-a-base64-key", "gho_access")).toThrow(/32/);
  });
});