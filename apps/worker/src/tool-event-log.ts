const MAX_STRING_LENGTH = 64 * 1024;
const MAX_DEPTH = 12;
const REDACTED = "[Redacted]";
const TRUNCATED = "\n...[truncated in log]";
const SENSITIVE_KEY = /^(?:authorization|cookie|set-cookie|token|accessToken|refreshToken|apiKey|secret|password|clientSecret|privateKey)$/i;

function sanitize(value: unknown, depth: number, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return REDACTED;
  if (depth >= MAX_DEPTH) return "[Maximum log depth reached]";
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, depth + 1, entryKey)])
    );
  }
  return value;
}

/**
 * Makes SDK tool event data safe and bounded enough for structured session logs.
 * The unmodified event continues to be persisted in the session database.
 */
export function sanitizeToolEventForLog(data: Record<string, unknown>): Record<string, unknown> {
  return sanitize(data, 0) as Record<string, unknown>;
}
