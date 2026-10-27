import {
  advanceSecureForm,
  parseSecureFormDefinition,
  secureFormCreateBodySchema,
  secureFormSubmitSchema,
  toSecureFormSnapshot,
  type SecureFormDelivery,
  type SecureFormSnapshot,
  type SecureFormStepDelivery
} from "@app/contracts";
import { db, PermissionStatus, Prisma, SecureFormStatus, SessionStatus, TurnStatus } from "@app/db";
import { SecureFormVault } from "./secure-form-vault.js";

export class SecureFormRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SecureFormRequestError";
  }
}

function publicEventData(snapshot: SecureFormSnapshot): Record<string, unknown> {
  return JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
}

export function createSecureFormService(options: {
  vault: SecureFormVault;
  timeoutSeconds: number;
  appendEvent: (sessionId: string, turnId: string | null, kind: string, data: Record<string, unknown>) => Promise<void>;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  async function sessionUserId(sessionId: string): Promise<string | null> {
    const session = await db.chatSession.findUnique({ where: { id: sessionId }, select: { userId: true } });
    return session?.userId ?? null;
  }

  async function resumeIfIdle(sessionId: string, turnId: string): Promise<void> {
    const [forms, permissions] = await Promise.all([
      db.secureFormRequest.count({ where: { turnId, status: SecureFormStatus.PENDING } }),
      db.permissionRequest.count({ where: { turnId, status: PermissionStatus.PENDING } })
    ]);
    if (forms > 0 || permissions > 0) return;
    await db.turn.updateMany({ where: { id: turnId, status: TurnStatus.WAITING_APPROVAL }, data: { status: TurnStatus.RUNNING } });
    const stillWaiting = await db.turn.count({ where: { sessionId, status: TurnStatus.WAITING_APPROVAL } });
    if (stillWaiting === 0) {
      await db.chatSession.updateMany({ where: { id: sessionId, status: SessionStatus.WAITING_APPROVAL }, data: { status: SessionStatus.RUNNING } });
    }
  }

  async function finish(row: {
    id: string;
    sessionId: string;
    turnId: string;
    title: string;
    subtitle: string;
    targetSite: string;
    purpose: string;
    steps: Prisma.JsonValue;
    currentStep: number;
    status: string;
    expiresAt: Date;
  }, status: typeof SecureFormStatus.CANCELLED | typeof SecureFormStatus.EXPIRED, action: string, reason: string): Promise<SecureFormSnapshot | null> {
    const changed = await db.secureFormRequest.updateMany({
      where: { id: row.id, status: SecureFormStatus.PENDING },
      data: { status, decidedAt: now() }
    });
    if (changed.count === 0) return null;
    options.vault.discard(row.id);
    const snapshot = toSecureFormSnapshot({ ...row, status });
    await options.appendEvent(snapshot.sessionId, snapshot.turnId, "secure-form.completed", publicEventData(snapshot));
    await db.auditLog.create({
      data: {
        userId: await sessionUserId(row.sessionId),
        action,
        targetId: row.id,
        metadata: { sessionId: row.sessionId, turnId: row.turnId, reason, status: snapshot.status }
      }
    });
    await resumeIfIdle(row.sessionId, row.turnId);
    return snapshot;
  }

  return {
    async create(input: unknown): Promise<SecureFormSnapshot> {
      const body = secureFormCreateBodySchema.safeParse(input);
      if (!body.success) throw new SecureFormRequestError("Invalid secure form request", 400);
      let definition;
      try {
        definition = parseSecureFormDefinition(body.data);
      } catch {
        throw new SecureFormRequestError("Invalid secure form request", 400);
      }
      const session = await db.chatSession.findUnique({ where: { id: body.data.sessionId } });
      if (!session) throw new SecureFormRequestError("Session not found", 404);
      const turn = await db.turn.findFirst({
        where: { sessionId: session.id, status: { in: [TurnStatus.RUNNING, TurnStatus.WAITING_APPROVAL] } },
        orderBy: { createdAt: "desc" }
      });
      if (!turn) throw new SecureFormRequestError("No active turn can request a secure form", 409);
      const existing = await db.secureFormRequest.findFirst({ where: { turnId: turn.id, status: SecureFormStatus.PENDING } });
      if (existing) throw new SecureFormRequestError("A secure form is already open for this turn", 409);
      const expiresAt = new Date(now().getTime() + options.timeoutSeconds * 1000);
      const row = await db.secureFormRequest.create({
        data: {
          sessionId: session.id,
          turnId: turn.id,
          title: definition.title,
          subtitle: definition.subtitle ?? "Secure form",
          targetSite: definition.targetSite,
          purpose: definition.purpose,
          steps: definition.steps as unknown as Prisma.InputJsonValue,
          expiresAt
        }
      });
      await db.turn.updateMany({ where: { id: turn.id, status: TurnStatus.RUNNING }, data: { status: TurnStatus.WAITING_APPROVAL } });
      await db.chatSession.updateMany({ where: { id: session.id, status: SessionStatus.RUNNING }, data: { status: SessionStatus.WAITING_APPROVAL } });
      const snapshot = toSecureFormSnapshot(row);
      await options.appendEvent(snapshot.sessionId, snapshot.turnId, "secure-form.requested", publicEventData(snapshot));
      await db.auditLog.create({
        data: {
          userId: session.userId,
          action: "secure-form.requested",
          targetId: row.id,
          metadata: { sessionId: session.id, turnId: turn.id, targetSite: snapshot.targetSite, stepCount: snapshot.steps.length }
        }
      });
      return snapshot;
    },

    async submit(userId: string, sessionId: string, formId: string, input: unknown): Promise<{ status: string; currentStep: number; stepId: string }> {
      const parsed = secureFormSubmitSchema.safeParse(input);
      if (!parsed.success) throw new SecureFormRequestError("Invalid secure form submission", 400);
      const row = await db.secureFormRequest.findFirst({ where: { id: formId, sessionId } });
      if (!row) throw new SecureFormRequestError("Secure form not found", 404);
      if (row.status !== SecureFormStatus.PENDING) throw new SecureFormRequestError("Secure form is no longer pending", 409);
      if (row.expiresAt <= now()) {
        await finish(row, SecureFormStatus.EXPIRED, "secure-form.expired", "timeout");
        throw new SecureFormRequestError("Secure form is no longer pending", 409);
      }
      const steps = toSecureFormSnapshot(row).steps;
      const advance = advanceSecureForm({ steps, currentStep: row.currentStep, submission: parsed.data });
      if (!advance.ok) throw new SecureFormRequestError(advance.error, 400);
      options.vault.putStep(row.id, advance.stepId, advance.values, row.expiresAt.getTime(), now().getTime());
      const status = advance.status === "submitted" ? SecureFormStatus.SUBMITTED : SecureFormStatus.PENDING;
      const changed = await db.secureFormRequest.updateMany({
        where: { id: row.id, status: SecureFormStatus.PENDING, currentStep: row.currentStep },
        data: { currentStep: advance.currentStep, status, ...(status === SecureFormStatus.SUBMITTED ? { decidedAt: now() } : {}) }
      });
      if (changed.count === 0) {
        options.vault.discardStep(row.id, advance.stepId);
        throw new SecureFormRequestError("Secure form is no longer pending", 409);
      }
      const updated = await db.secureFormRequest.findUniqueOrThrow({ where: { id: row.id } });
      const snapshot = toSecureFormSnapshot(updated);
      const kind = snapshot.status === "pending" ? "secure-form.updated" : "secure-form.completed";
      await options.appendEvent(snapshot.sessionId, snapshot.turnId, kind, publicEventData(snapshot));
      await db.auditLog.create({
        data: {
          userId,
          action: "secure-form.submitted",
          targetId: row.id,
          metadata: { sessionId, turnId: row.turnId, stepId: advance.stepId, fieldNames: advance.fieldNames, status: snapshot.status }
        }
      });
      if (snapshot.status !== "pending") await resumeIfIdle(snapshot.sessionId, snapshot.turnId);
      return { status: snapshot.status, currentStep: snapshot.currentStep, stepId: advance.stepId };
    },

    async cancel(sessionId: string, formId: string, reason: string): Promise<SecureFormSnapshot> {
      const row = await db.secureFormRequest.findFirst({ where: { id: formId, sessionId } });
      if (!row) throw new SecureFormRequestError("Secure form not found", 404);
      const snapshot = await finish(row, SecureFormStatus.CANCELLED, "secure-form.cancelled", reason);
      if (!snapshot) throw new SecureFormRequestError("Secure form is no longer pending", 409);
      return snapshot;
    },

    async expire(sessionId: string, formId: string, reason = "timeout"): Promise<SecureFormSnapshot> {
      const row = await db.secureFormRequest.findFirst({ where: { id: formId, sessionId } });
      if (!row) throw new SecureFormRequestError("Secure form not found", 404);
      const snapshot = await finish(row, SecureFormStatus.EXPIRED, "secure-form.expired", reason);
      if (!snapshot) throw new SecureFormRequestError("Secure form is no longer pending", 409);
      return snapshot;
    },

    async cancelPending(filter: { sessionId?: string; turnId?: string }, reason: string): Promise<number> {
      const rows = await db.secureFormRequest.findMany({
        where: {
          status: SecureFormStatus.PENDING,
          ...(filter.sessionId ? { sessionId: filter.sessionId } : {}),
          ...(filter.turnId ? { turnId: filter.turnId } : {})
        }
      });
      let count = 0;
      for (const row of rows) {
        const snapshot = await finish(row, SecureFormStatus.CANCELLED, "secure-form.cancelled", reason);
        if (snapshot) count += 1;
      }
      return count;
    },

    async expireAllPending(reason: string): Promise<number> {
      const rows = await db.secureFormRequest.findMany({ where: { status: SecureFormStatus.PENDING } });
      let count = 0;
      for (const row of rows) {
        const snapshot = await finish(row, SecureFormStatus.EXPIRED, "secure-form.expired", reason);
        if (snapshot) count += 1;
      }
      return count;
    },

    async claim(sessionId: string, formId: string): Promise<SecureFormDelivery> {
      const row = await db.secureFormRequest.findUnique({ where: { id: formId } });
      if (!row || row.sessionId !== sessionId) throw new SecureFormRequestError("Secure form not found", 404);
      if (row.expiresAt <= now()) {
        options.vault.discard(formId);
        throw new SecureFormRequestError("Secure form values expired", 409);
      }
      if (row.status !== SecureFormStatus.SUBMITTED) throw new SecureFormRequestError("Secure form is not ready to claim", 409);
      const steps = toSecureFormSnapshot(row).steps;
      const claimed = options.vault.claimAll(formId, steps.map((step) => step.id), now().getTime());
      if (!claimed) throw new SecureFormRequestError("Secure form values are no longer available", 409);
      return {
        formId,
        targetSite: row.targetSite,
        purpose: row.purpose,
        steps: steps.map((step) => step.kind === "confirm"
          ? { id: step.id, kind: step.kind, confirmed: true }
          : { id: step.id, kind: step.kind, values: claimed.get(step.id) ?? {} })
      };
    },

    async claimStep(sessionId: string, formId: string, stepId: string): Promise<SecureFormStepDelivery> {
      const row = await db.secureFormRequest.findUnique({ where: { id: formId } });
      if (!row || row.sessionId !== sessionId) throw new SecureFormRequestError("Secure form not found", 404);
      if (row.expiresAt <= now()) {
        options.vault.discard(formId);
        throw new SecureFormRequestError("Secure form values expired", 409);
      }
      if (row.status !== SecureFormStatus.PENDING && row.status !== SecureFormStatus.SUBMITTED) {
        throw new SecureFormRequestError("Secure form is not ready to claim", 409);
      }
      const steps = toSecureFormSnapshot(row).steps;
      const index = steps.findIndex((step) => step.id === stepId);
      const step = index < 0 ? undefined : steps[index];
      if (!step) throw new SecureFormRequestError("Secure form step not found", 404);
      if (index >= row.currentStep) throw new SecureFormRequestError("Secure form step is not ready to claim", 409);
      const values = options.vault.claimStep(formId, stepId, now().getTime());
      if (!values) throw new SecureFormRequestError("Secure form values are no longer available", 409);
      if (step.kind === "confirm") return { id: step.id, kind: step.kind, confirmed: true };
      return { id: step.id, kind: step.kind, values };
    },

    discard(formIds: readonly string[]): number {
      return options.vault.discardMany(formIds);
    },

    async read(sessionId: string, formId: string): Promise<SecureFormSnapshot> {
      const row = await db.secureFormRequest.findFirst({ where: { id: formId, sessionId } });
      if (!row) throw new SecureFormRequestError("Secure form not found", 404);
      return toSecureFormSnapshot(row);
    },

    async listForSession(sessionId: string): Promise<SecureFormSnapshot[]> {
      const rows = await db.secureFormRequest.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" }, take: 50 });
      const snapshots: SecureFormSnapshot[] = [];
      for (const row of rows) {
        try {
          snapshots.push(toSecureFormSnapshot(row));
        } catch {
          // Skip unreadable metadata. Do not log the stored document.
        }
      }
      return snapshots;
    }
  };
}

export type SecureFormService = ReturnType<typeof createSecureFormService>;
