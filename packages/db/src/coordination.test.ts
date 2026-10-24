import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { expiredForeignLeaseWhere, isExpiredForeignLease } from "./turn-lease.js";

const databasePath = path.join(tmpdir(), `copilot-coordination-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${databasePath}`;
const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [
  path.join(packageDirectory, "node_modules", "prisma", "build", "index.js"),
  "db",
  "push",
  "--skip-generate",
  "--accept-data-loss",
  "--schema",
  path.join(packageDirectory, "prisma-sqlite", "schema.prisma")
], { cwd: packageDirectory, env: process.env, stdio: "pipe" });

const { createPrismaGitHubTokenStore, db } = await import("./index.js");

afterAll(async () => {
  await db.$disconnect();
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
    rm(`${databasePath}-wal`, { force: true })
  ]);
});

describe("SQLite lease and refresh claims", () => {
  it("lets only one worker claim a single-use refresh token", async () => {
    const user = await db.user.create({ data: { login: `octo-${randomUUID()}` } });
    const account = await db.gitHubAccount.create({ data: {
      userId: user.id,
      provider: "github",
      providerUserId: randomUUID(),
      host: "github.com",
      encryptedAccessToken: "old-access",
      encryptedRefreshToken: "old-refresh",
      accessTokenExpiresAt: new Date(Date.now() + 1_000)
    } });
    const store = createPrismaGitHubTokenStore(db);
    const until = new Date(Date.now() + 60_000);
    const now = new Date();
    const [first, second] = await Promise.all([
      store.claim({ id: account.id, encryptedRefreshToken: "old-refresh", owner: "worker-a", until, now }),
      store.claim({ id: account.id, encryptedRefreshToken: "old-refresh", owner: "worker-b", until, now })
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const claimed = await store.claim({ id: account.id, encryptedRefreshToken: "old-refresh", owner: "worker-c", until: new Date(Date.now() + 60_000), now: new Date(Date.now() + 120_000) });
    expect(claimed).toBe(true);
  });

  it("selects the same turns the lease predicate marks recoverable", async () => {
    const user = await db.user.create({ data: { login: `octo-${randomUUID()}` } });
    const account = await db.gitHubAccount.create({ data: {
      userId: user.id,
      provider: "github",
      providerUserId: randomUUID(),
      host: "github.com",
      encryptedAccessToken: "token"
    } });
    const session = await db.chatSession.create({ data: {
      sdkSessionId: randomUUID(),
      userId: user.id,
      githubAccountId: account.id,
      repositoryId: "repo",
      repositoryName: "Repo"
    } });
    const now = new Date("2026-10-24T12:00:00.000Z");
    const fixtures = [
      { name: "expired-peer", status: "RUNNING", leaseOwner: "worker-b", leaseExpiresAt: new Date(now.getTime() - 1_000) },
      { name: "live-peer", status: "RUNNING", leaseOwner: "worker-b", leaseExpiresAt: new Date(now.getTime() + 30_000) },
      { name: "own-expired", status: "RUNNING", leaseOwner: "worker-a", leaseExpiresAt: new Date(now.getTime() - 1_000) },
      { name: "unowned", status: "WAITING_APPROVAL", leaseOwner: null, leaseExpiresAt: new Date(now.getTime() + 30_000) },
      { name: "missing-expiry", status: "RUNNING", leaseOwner: "worker-b", leaseExpiresAt: null },
      { name: "completed", status: "COMPLETED", leaseOwner: "worker-b", leaseExpiresAt: new Date(now.getTime() - 1_000) }
    ];
    const created = [];
    for (const fixture of fixtures) {
      created.push(await db.turn.create({ data: {
        sessionId: session.id,
        idempotencyKey: fixture.name,
        status: fixture.status,
        leaseOwner: fixture.leaseOwner,
        leaseExpiresAt: fixture.leaseExpiresAt
      } }));
    }
    const selected = await db.turn.findMany({ where: { sessionId: session.id, ...expiredForeignLeaseWhere("worker-a", now) }, select: { idempotencyKey: true } });
    const selectedNames = selected.map((turn) => turn.idempotencyKey).sort();
    const expected = created.filter((turn) => isExpiredForeignLease({
      status: turn.status,
      leaseOwner: turn.leaseOwner,
      leaseExpiresAt: turn.leaseExpiresAt
    }, "worker-a", now.getTime())).map((turn) => turn.idempotencyKey).sort();
    expect(selectedNames).toEqual(expected);
    expect(selectedNames).toEqual(["expired-peer", "missing-expiry", "unowned"]);
  });
});
