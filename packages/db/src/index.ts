import { PrismaClient as PostgreSqlPrismaClient } from "@prisma/client";
import { PrismaClient as SqlitePrismaClient } from "../generated/sqlite/index.js";

export type DatabaseMode = "local" | "multi-user";

export function resolveDatabaseMode(environment: NodeJS.ProcessEnv = process.env): DatabaseMode {
  if (environment.DATABASE_MODE === "local" || environment.DATABASE_MODE === "multi-user") return environment.DATABASE_MODE;
  if (environment.DATABASE_MODE) throw new Error("DATABASE_MODE must be either local or multi-user");
  return environment.DATABASE_URL?.startsWith("file:") ? "local" : "multi-user";
}

export function validateDatabaseUrl(mode: DatabaseMode, url: string): void {
  const sqlite = url.startsWith("file:");
  if (mode === "local" && !sqlite) throw new Error("DATABASE_MODE=local requires a SQLite DATABASE_URL beginning with file:");
  if (mode === "multi-user" && sqlite) throw new Error("DATABASE_MODE=multi-user requires a PostgreSQL DATABASE_URL");
}

export const databaseMode = resolveDatabaseMode();
if (process.env.DATABASE_URL) validateDatabaseUrl(databaseMode, process.env.DATABASE_URL);
const globalForPrisma = globalThis as unknown as { prisma?: PostgreSqlPrismaClient };
const log = process.env.NODE_ENV === "development" ? ["warn", "error"] as const : ["error"] as const;
const createClient = () => databaseMode === "local"
  ? new SqlitePrismaClient({ log: [...log] })
  : new PostgreSqlPrismaClient({ log: [...log] });

export const db = (globalForPrisma.prisma ?? createClient()) as unknown as PostgreSqlPrismaClient;

if (databaseMode === "local") {
  await db.$queryRawUnsafe("PRAGMA busy_timeout = 10000");
  await db.$queryRawUnsafe("PRAGMA foreign_keys = ON");
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
}

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

export function toDatabaseCursor(value: bigint): bigint {
  return (databaseMode === "local" ? Number(value) : value) as unknown as bigint;
}

export * from "@prisma/client";
