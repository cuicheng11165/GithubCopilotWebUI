import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const databasePath = path.join(tmpdir(), `copilotdeck-db-test-${process.pid}.db`);
process.env.DATABASE_URL = `file:${databasePath}`;
const { db, toDatabaseCursor, validateDatabaseUrl } = await import("./index.js");

afterAll(async () => {
  await db.$disconnect();
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
    rm(`${databasePath}-wal`, { force: true })
  ]);
});

describe("SQLite database", () => {
  it("accepts only SQLite database URLs", () => {
    expect(() => validateDatabaseUrl("file:./copilot.db")).not.toThrow();
    expect(() => validateDatabaseUrl("mysql://localhost/copilot")).toThrow("SQLite");
  });

  it("converts replay cursors to safe SQLite integers", () => {
    expect(toDatabaseCursor(42n)).toBe(42);
    expect(() => toDatabaseCursor(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow("safe integer");
  });
});
