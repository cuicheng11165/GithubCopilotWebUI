import { describe, expect, it } from "vitest";
import {
  advanceSecureForm,
  collectSecretValues,
  mergeSecureFormSnapshot,
  parseSecureFormDefinition,
  parseSecureFormToolInput,
  publicSecureFormHookResponse,
  redactSecretText,
  redactSecureFormToolPayload,
  sanitizeDeliveryReport,
  secureFormModelResult,
  toSecureFormSnapshot,
  visibleSecureFormCards,
  type SecureFormSnapshot
} from "./secure-form.js";

const definition = {
  title: "Sign in to Microsoft (SharePoint Guild)",
  targetSite: "login.microsoftonline.com",
  purpose: "Open the SharePoint site",
  steps: [
    { id: "account", kind: "input", fields: [{ name: "email", label: "Email", type: "email" }] },
    { id: "secret", kind: "input", fields: [{ name: "password", label: "Password", type: "password" }] },
    { id: "code", kind: "input", prompt: "Enter the verification code", fields: [{ name: "otp", label: "Code", type: "otp" }] },
    { id: "approve", kind: "confirm", prompt: "Approve the sign-in on your phone, then continue." }
  ]
};

function snapshot(overrides: Partial<SecureFormSnapshot> = {}): SecureFormSnapshot {
  const parsed = parseSecureFormDefinition(definition);
  return {
    id: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    turnId: "33333333-3333-4333-8333-333333333333",
    subtitle: "Secure form",
    currentStep: 0,
    status: "pending",
    expiresAt: "2026-10-26T12:10:00.000Z",
    ...parsed,
    ...overrides
  };
}

describe("secure form schema", () => {
  it("normalizes multi-step login and MFA definitions", () => {
    const parsed = parseSecureFormDefinition(definition);
    expect(parsed.steps.map((step) => step.kind)).toEqual(["input", "input", "input", "confirm"]);
    expect(parsed.steps[0]?.fields[0]?.required).toBe(true);
    expect(parsed.subtitle).toBeUndefined();
  });

  it("rejects a confirm step that asks for a secret", () => {
    expect(() => parseSecureFormDefinition({
      ...definition,
      steps: [{ id: "approve", kind: "confirm", fields: [{ name: "otp", label: "Code", type: "otp" }] }]
    })).toThrow(/confirmation step/i);
  });

  it("keeps a delivery command out of the field schema", () => {
    const parsed = parseSecureFormToolInput({ ...definition, deliveryCommand: "node fill.mjs", deliveryMode: "each-step" });
    expect(parsed.deliveryCommand).toBe("node fill.mjs");
    expect(parsed.deliveryMode).toBe("each-step");
    expect(JSON.stringify(parsed.steps)).not.toContain("fill.mjs");
  });
});

describe("secure form steps", () => {
  const steps = parseSecureFormDefinition(definition).steps;

  it("accepts email, then password, then otp, then an in-app approval", () => {
    const email = advanceSecureForm({ steps, currentStep: 0, submission: { stepId: "account", values: { email: "ada@example.com" } } });
    expect(email).toMatchObject({ ok: true, status: "pending", currentStep: 1, values: { email: "ada@example.com" } });
    const password = advanceSecureForm({ steps, currentStep: 1, submission: { stepId: "secret", values: { password: " correct horse " } } });
    expect(password).toMatchObject({ ok: true, values: { password: " correct horse " } });
    const otp = advanceSecureForm({ steps, currentStep: 2, submission: { stepId: "code", values: { otp: " 123456\n" } } });
    expect(otp).toMatchObject({ ok: true, values: { otp: "123456" } });
    const approve = advanceSecureForm({ steps, currentStep: 3, submission: { stepId: "approve", confirmed: true } });
    expect(approve).toMatchObject({ ok: true, status: "submitted", currentStep: 4, values: {}, confirmed: true });
  });

  it("does not echo a rejected secret in the error", () => {
    const result = advanceSecureForm({ steps, currentStep: 0, submission: { stepId: "account", values: { email: "not-an-email" } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain("not-an-email");
  });

  it("rejects a skipped step and unknown fields", () => {
    expect(advanceSecureForm({ steps, currentStep: 0, submission: { stepId: "secret", values: { password: "x" } } }).ok).toBe(false);
    expect(advanceSecureForm({ steps, currentStep: 1, submission: { stepId: "secret", values: { password: "x", email: "a@b.c" } } }).ok).toBe(false);
  });
});

describe("secure form replay and model results", () => {
  it("replays pending then submitted cards without moving backwards", () => {
    const pending = snapshot();
    const afterEmail = snapshot({ currentStep: 1 });
    const submitted = snapshot({ currentStep: 4, status: "submitted" });
    let forms = mergeSecureFormSnapshot([], pending);
    forms = mergeSecureFormSnapshot(forms, afterEmail);
    forms = mergeSecureFormSnapshot(forms, pending);
    forms = mergeSecureFormSnapshot(forms, submitted);
    forms = mergeSecureFormSnapshot(forms, afterEmail);
    expect(forms).toEqual([submitted]);
    expect(visibleSecureFormCards(afterEmail).map((card) => card.state)).toEqual(["submitted", "open"]);
    expect(visibleSecureFormCards(submitted).every((card) => card.state === "submitted")).toBe(true);
  });

  it("keeps a cancelled card ahead of an older pending replay", () => {
    const pending = snapshot();
    const cancelled = snapshot({ status: "cancelled" });
    const forms = mergeSecureFormSnapshot(mergeSecureFormSnapshot([], pending), cancelled);
    expect(mergeSecureFormSnapshot(forms, pending)[0]?.status).toBe("cancelled");
  });

  it("returns only status metadata to the model and strips a buggy delivery report", () => {
    const result = secureFormModelResult({ status: "submitted", formId: snapshot().id, delivered: true, exitCode: 0, stdout: "signed in" });
    expect(result).not.toHaveProperty("values");
    expect(result).not.toHaveProperty("password");
    const report = sanitizeDeliveryReport({ delivered: true, exitCode: 0, stdout: "ok", stderr: "", values: { password: "hunter2" }, secret: "nope" });
    expect(report).toEqual({ delivered: true, exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    expect(JSON.stringify(report)).not.toContain("hunter2");
  });

  it("redacts secrets from command output and tool payloads", () => {
    expect(redactSecretText("password=hunter2 token=hunter2-extra", ["hunter2"])).toBe("password=[redacted] token=[redacted]-extra");
    expect(redactSecretText("all good", [""])).toBe("all good");
    const redacted = redactSecureFormToolPayload({
      toolName: "request_secure_form",
      arguments: { purpose: "Sign in", values: { password: "hunter2" }, nested: { otp: "123456" } }
    }) as { arguments: { purpose: string; values: string; nested: { otp: string } } };
    expect(redacted.arguments.purpose).toBe("Sign in");
    expect(redacted.arguments.values).toBe("[Redacted]");
    expect(redacted.arguments.nested.otp).toBe("[Redacted]");
  });

  it("stores no field values on the public snapshot", () => {
    const stored = toSecureFormSnapshot({
      id: snapshot().id,
      sessionId: snapshot().sessionId,
      turnId: snapshot().turnId,
      title: definition.title,
      subtitle: "Secure form",
      targetSite: definition.targetSite,
      purpose: definition.purpose,
      steps: definition.steps,
      currentStep: 1,
      status: "PENDING",
      expiresAt: new Date("2026-10-26T12:10:00.000Z")
    });
    expect(JSON.stringify(stored)).not.toContain("hunter2");
    expect(stored.status).toBe("pending");
    expect(stored.subtitle).toBe("Secure form");
  });

  it("collects stdin secrets and publishes a hook response without them", () => {
    const secrets = collectSecretValues({
      formId: snapshot().id,
      targetSite: "login.microsoftonline.com",
      purpose: "Sign in",
      steps: [
        { id: "account", kind: "input", values: { email: "ada@example.com" } },
        { id: "approve", kind: "confirm", confirmed: true }
      ]
    });
    expect(secrets).toEqual(["ada@example.com"]);
    const published = publicSecureFormHookResponse({ status: "submitted", delivered: true, fieldNames: ["email"], stdout: "ada@example.com" });
    expect(published).not.toHaveProperty("steps");
    expect(published.fieldNames).toEqual(["email"]);
  });
});
