import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

const BASE64_STANDARD = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64_URL = /^[A-Za-z0-9_-]+={0,2}$/;

export function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function bearerAuthorizationMatches(authorization: string | readonly string[] | undefined, token: string): boolean {
  if (typeof authorization !== "string") return false;
  return timingSafeEqualString(authorization, `Bearer ${token}`);
}

export function isPlaceholderSecret(value: string): boolean {
  return value.trim().toLowerCase().startsWith("replace-with-");
}

export function assertServiceSecret(name: string, value: string): void {
  if (isPlaceholderSecret(value)) {
    throw new Error(`${name} is still an .env.example placeholder. Generate a unique random value before startup.`);
  }
  if (value.trim().length < 32) {
    throw new Error(`${name} must be at least 32 characters.`);
  }
}

export function decodeTokenEncryptionKey(value: string, name = "TOKEN_ENCRYPTION_KEY"): Buffer {
  if (isPlaceholderSecret(value)) {
    throw new Error(`${name} is still an .env.example placeholder. Generate 32 random bytes and encode them as base64 before startup.`);
  }
  const trimmed = value.trim();
  const urlSafe = trimmed.includes("-") || trimmed.includes("_");
  if (!(urlSafe ? BASE64_URL : BASE64_STANDARD).test(trimmed)) {
    throw new Error(`${name} must be a base64-encoded 32-byte key.`);
  }
  const decoded = Buffer.from(trimmed.replaceAll("-", "+").replaceAll("_", "/"), "base64");
  if (decoded.length !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes (got ${decoded.length}).`);
  }
  return decoded;
}

export function serviceTokenSchema(name: string) {
  return z.string({
    required_error: `${name} is required.`,
    invalid_type_error: `${name} must be a string.`
  }).superRefine((value, ctx) => {
    try {
      assertServiceSecret(name, value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : `${name} is invalid.`
      });
    }
  });
}

export function tokenEncryptionKeySchema(name = "TOKEN_ENCRYPTION_KEY") {
  return z.string({
    required_error: `${name} is required.`,
    invalid_type_error: `${name} must be a string.`
  }).superRefine((value, ctx) => {
    try {
      decodeTokenEncryptionKey(value, name);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : `${name} is invalid.`
      });
    }
  });
}

export function parseEnv<Schema extends z.ZodTypeAny>(schema: Schema, source: Record<string, unknown> = process.env): z.infer<Schema> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "environment";
      return `${path}: ${issue.message}`;
    }).join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}
