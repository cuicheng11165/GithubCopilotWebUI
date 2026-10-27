import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databasePath = path.join(tmpdir(), `copilotdeck-secure-form-${process.pid}.db`);
process.env.DATABASE_URL = `file:${databasePath}`;

const { db } = await import("@app/db");
const { createSecureFormService } = await import("./secure-form-service.js");
const { SecureFormVault } = await import("./secure-form-vault.js");

const password = "hunter2-not-for-logs";
const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
const service = createSecureFormService({
  vault: new SecureFormVault(),
  timeoutSeconds: 600,
  appendEvent: async (_sessionId, _turnId, kind, data) => {
    events.push({ kind, data });
  }
});

beforeAll(() => {
  const prismaCli = path.resolve("packages/db/node_modules/prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "db", "push", "--schema", path.resolve("packages/db/prisma-sqlite/schema.prisma"), "--skip-generate", "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
    stdio: "pipe"
  });
});

afterAll(async () => {
  await db.$disconnect();
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
    rm(`${databasePath}-wal`, { force: true })
  ]);
});

async function seedActiveTurn() {
  const user = await db.user.create({ data: { login: `user-${randomUUID()}` } });
  const account = await db.gitHubAccount.create({
    data: { userId: user.id, provider: "github", providerUserId: randomUUID(), host: "github.com", encryptedAccessToken: "encrypted" }
  });
  const session = await db.chatSession.create({
    data: {
      sdkSessionId: randomUUID(),
      userId: user.id,
      githubAccountId: account.id,
      repositoryId: "repo",
      repositoryName: "Repo",
      model: "gpt-test",
      status: "RUNNING"
    }
  });
  const turn = await db.turn.create({ data: { sessionId: session.id, idempotencyKey: randomUUID(), status: "RUNNING" } });
  return { user, session, turn };
}

const definition = {
  title: "Sign in to Microsoft (SharePoint Guild)",
  targetSite: "login.microsoftonline.com",
  purpose: "Open the SharePoint site",
  steps: [
    { id: "account", kind: "input", fields: [{ name: "email", label: "Email", type: "email" }] },
    { id: "secret", kind: "input", fields: [{ name: "password", label: "Password", type: "password" }] }
  ]
};

describe("secure form service", () => {
  it("keeps submitted secrets out of events, audits, and the database", async () => {
    const { user, session } = await seedActiveTurn();
    events.length = 0;
    const created = await service.create({ sessionId: session.id, ...definition });
    expect(created.status).toBe("pending");
    const email = await service.submit(user.id, session.id, created.id, { stepId: "account", values: { email: "ada@example.com" } });
    expect(email).toMatchObject({ status: "pending", currentStep: 1 });
    const done = await service.submit(user.id, session.id, created.id, { stepId: "secret", values: { password } });
    expect(done.status).toBe("submitted");

    const stored = await db.secureFormRequest.findUniqueOrThrow({ where: { id: created.id } });
    const audits = await db.auditLog.findMany({ where: { targetId: created.id } });
    const persisted = JSON.stringify({ stored, audits, events });
    expect(persisted).not.toContain(password);
    expect(persisted).not.toContain("ada@example.com");
    expect(events.map((event) => event.kind)).toEqual(["secure-form.requested", "secure-form.updated", "secure-form.completed"]);

    const delivery = await service.claim(session.id, created.id);
    expect(delivery.steps[1]?.values).toEqual({ password });
    await expect(service.claim(session.id, created.id)).rejects.toThrow(/no longer available/i);
    const resumed = await db.turn.findUniqueOrThrow({ where: { id: created.turnId } });
    expect(resumed.status).toBe("RUNNING");
  });

  it("cancels a pending form on stop and resumes the turn", async () => {
    const { session } = await seedActiveTurn();
    const created = await service.create({ sessionId: session.id, ...definition });
    const cancelled = await service.cancel(session.id, created.id, "stop");
    expect(cancelled.status).toBe("cancelled");
    await expect(service.submit((await db.chatSession.findUniqueOrThrow({ where: { id: session.id } })).userId, session.id, created.id, { stepId: "account", values: { email: "ada@example.com" } })).rejects.toThrow(/no longer pending/i);
    expect(await db.turn.findFirstOrThrow({ where: { sessionId: session.id } })).toMatchObject({ status: "RUNNING" });
  });

  it("rejects a claim for another session", async () => {
    const first = await seedActiveTurn();
    const second = await seedActiveTurn();
    const created = await service.create({
      sessionId: first.session.id,
      ...definition,
      steps: [{ id: "account", kind: "input", fields: [{ name: "email", label: "Email", type: "email" }] }]
    });
    await service.submit(first.user.id, first.session.id, created.id, { stepId: "account", values: { email: "ada@example.com" } });
    await expect(service.claim(second.session.id, created.id)).rejects.toThrow(/not found/i);
  });
});
