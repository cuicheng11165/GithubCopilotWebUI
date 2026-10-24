import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertServiceSecret,
  bearerAuthorizationMatches,
  decodeTokenEncryptionKey,
  parseEnv,
  serviceTokenSchema,
  timingSafeEqualString,
  tokenEncryptionKeySchema
} from "./index.js";

const examplePlaceholders = [
  "replace-with-at-least-32-random-characters",
  "replace-with-base64-encoded-32-byte-key",
  "replace-with-a-long-random-service-token",
  "replace-with-a-different-long-random-service-token"
];

describe("timing-safe comparison", () => {
  it("matches equal strings and rejects mismatches without throwing on length", () => {
    expect(timingSafeEqualString("csrf-token", "csrf-token")).toBe(true);
    expect(timingSafeEqualString("", "")).toBe(true);
    expect(timingSafeEqualString("Bearer secret-one", "Bearer secret-two")).toBe(false);
    expect(timingSafeEqualString("short", "much-longer-value")).toBe(false);
  });

  it("compares bearer tokens in constant time", () => {
    expect(bearerAuthorizationMatches("Bearer service-token", "service-token")).toBe(true);
    expect(bearerAuthorizationMatches("Bearer other-token", "service-token")).toBe(false);
    expect(bearerAuthorizationMatches("bearer service-token", "service-token")).toBe(false);
    expect(bearerAuthorizationMatches(undefined, "service-token")).toBe(false);
    expect(bearerAuthorizationMatches(["Bearer service-token"], "service-token")).toBe(false);
  });
});

describe("startup secret validation", () => {
  it("accepts a base64 32-byte encryption key and rejects hashed fallbacks", () => {
    const bytes = randomBytes(32);
    expect(decodeTokenEncryptionKey(bytes.toString("base64")).equals(bytes)).toBe(true);
    expect(decodeTokenEncryptionKey(bytes.toString("base64url")).equals(bytes)).toBe(true);
    expect(() => decodeTokenEncryptionKey("a".repeat(44))).toThrow(/exactly 32 bytes/);
    expect(() => decodeTokenEncryptionKey("this is not base64!!!")).toThrow(/base64-encoded 32-byte key/);
  });

  it("rejects .env.example placeholders for encryption and service secrets", () => {
    for (const placeholder of examplePlaceholders) {
      expect(() => decodeTokenEncryptionKey(placeholder)).toThrow(/placeholder/);
      expect(() => assertServiceSecret("COOKIE_SECRET", placeholder)).toThrow(/COOKIE_SECRET is still an \.env\.example placeholder/);
    }
    expect(() => assertServiceSecret("SANDBOX_RUNNER_TOKEN", "short")).toThrow(/at least 32 characters/);
    expect(() => assertServiceSecret("WORKER_CONTROL_TOKEN", randomBytes(48).toString("base64"))).not.toThrow();
  });

  it("fails config parsing with a message that names each invalid secret", () => {
    const schema = z.object({
      COOKIE_SECRET: serviceTokenSchema("COOKIE_SECRET"),
      TOKEN_ENCRYPTION_KEY: tokenEncryptionKeySchema(),
      WORKER_CONTROL_TOKEN: serviceTokenSchema("WORKER_CONTROL_TOKEN")
    });
    expect(() => parseEnv(schema, {
      COOKIE_SECRET: "replace-with-at-least-32-random-characters",
      TOKEN_ENCRYPTION_KEY: "replace-with-base64-encoded-32-byte-key",
      WORKER_CONTROL_TOKEN: "replace-with-a-different-long-random-service-token"
    })).toThrow(/Invalid environment configuration:[\s\S]*COOKIE_SECRET:[\s\S]*TOKEN_ENCRYPTION_KEY:[\s\S]*WORKER_CONTROL_TOKEN:/);

    const cookie = randomBytes(48).toString("base64");
    const worker = randomBytes(48).toString("base64");
    const key = randomBytes(32).toString("base64");
    expect(parseEnv(schema, {
      COOKIE_SECRET: cookie,
      TOKEN_ENCRYPTION_KEY: key,
      WORKER_CONTROL_TOKEN: worker
    })).toEqual({
      COOKIE_SECRET: cookie,
      TOKEN_ENCRYPTION_KEY: key,
      WORKER_CONTROL_TOKEN: worker
    });
  });
});
