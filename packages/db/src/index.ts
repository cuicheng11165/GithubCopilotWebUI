import { PrismaClient } from "../generated/sqlite/index.js";

export const ApprovalMode = { INTERACTIVE: "INTERACTIVE", SESSION_SCOPED: "SESSION_SCOPED", ALLOW_ALL: "ALLOW_ALL" } as const;
export const SessionStatus = { IDLE: "IDLE", QUEUED: "QUEUED", RUNNING: "RUNNING", WAITING_APPROVAL: "WAITING_APPROVAL", ERROR: "ERROR" } as const;
export const TurnStatus = { QUEUED: "QUEUED", RUNNING: "RUNNING", WAITING_APPROVAL: "WAITING_APPROVAL", COMPLETED: "COMPLETED", STOPPED: "STOPPED", FAILED: "FAILED" } as const;
export const MessageRole = { USER: "USER", ASSISTANT: "ASSISTANT", SYSTEM: "SYSTEM", TOOL: "TOOL" } as const;
export const PermissionStatus = { PENDING: "PENDING", APPROVED: "APPROVED", DENIED: "DENIED", EXPIRED: "EXPIRED" } as const;

export type ApprovalMode = typeof ApprovalMode[keyof typeof ApprovalMode];
export type SessionStatus = typeof SessionStatus[keyof typeof SessionStatus];
export type TurnStatus = typeof TurnStatus[keyof typeof TurnStatus];
export type MessageRole = typeof MessageRole[keyof typeof MessageRole];
export type PermissionStatus = typeof PermissionStatus[keyof typeof PermissionStatus];

export function validateDatabaseUrl(url: string): void {
  if (!url.startsWith("file:")) throw new Error("CopilotDeck requires a SQLite DATABASE_URL beginning with file:");
}

if (process.env.DATABASE_URL) validateDatabaseUrl(process.env.DATABASE_URL);
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
const log = process.env.NODE_ENV === "development" ? ["warn", "error"] as const : ["error"] as const;
const createClient = () => new PrismaClient({ log: [...log] });

export const db = globalForPrisma.prisma ?? createClient();

await db.$queryRawUnsafe("PRAGMA busy_timeout = 10000");
await db.$queryRawUnsafe("PRAGMA foreign_keys = ON");
await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

export function toDatabaseCursor(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Event cursor is outside SQLite's safe integer range");
  return Number(value);
}

export * from "../generated/sqlite/index.js";
