import { describe, expect, it, vi } from "vitest";
import type { SecureFormSnapshot } from "@app/contracts";
import { runSecureFormTool } from "./secure-form.js";

const sessionId = "22222222-2222-4222-8222-222222222222";
const formId = "11111111-1111-4111-8111-111111111111";
const definition = {
  title: "Sign in to Microsoft",
  targetSite: "login.microsoftonline.com",
  purpose: "Open SharePoint",
  steps: [{ id: "account", kind: "input", fields: [{ name: "email", label: "Email", type: "email" }] }]
};

function snapshot(status: SecureFormSnapshot["status"] = "pending"): SecureFormSnapshot {
  return {
    id: formId,
    sessionId,
    turnId: "33333333-3333-4333-8333-333333333333",
    title: "Sign in to Microsoft",
    subtitle: "Secure form",
    targetSite: "login.microsoftonline.com",
    purpose: "Open SharePoint",
    steps: [{ id: "account", kind: "input", fields: [{ name: "email", label: "Email", type: "email", required: true }] }],
    currentStep: status === "submitted" ? 1 : 0,
    status,
    expiresAt: "2099-01-01T00:00:00.000Z"
  };
}

describe("request_secure_form tool", () => {
  it("returns submitted without secret values and strips a buggy delivery payload", async () => {
    const deliver = vi.fn(async () => ({ delivered: true, exitCode: 0, stdout: "signed in", stderr: "", values: { password: "hunter2" } }));
    let resumedBeforeDeliver = false;
    let paused = false;
    const result = await runSecureFormTool({
      args: { ...definition, deliveryCommand: "node fill.mjs" },
      sessionId,
      pollMs: 1,
      pause: () => { paused = true; },
      resume: () => { paused = false; if (!resumedBeforeDeliver) resumedBeforeDeliver = true; },
      create: async () => snapshot(),
      readStatus: async () => "submitted",
      stopped: async () => false,
      cancel: async () => undefined,
      expire: async () => undefined,
      approveDelivery: async () => true,
      deliver,
      sleep: async () => undefined
    });
    expect(paused).toBe(false);
    expect(deliver).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "submitted", delivered: true, stdout: "signed in", exitCode: 0 });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(result).not.toHaveProperty("values");
    expect(result).not.toHaveProperty("password");
  });

  it("does not open a form when the delivery command is denied", async () => {
    const create = vi.fn();
    const result = await runSecureFormTool({
      args: { ...definition, deliveryCommand: "cat" },
      sessionId,
      pollMs: 1,
      pause: () => undefined,
      resume: () => undefined,
      create,
      readStatus: async () => "pending",
      stopped: async () => false,
      cancel: async () => undefined,
      expire: async () => undefined,
      approveDelivery: async () => false,
      deliver: async () => ({ delivered: true }),
      sleep: async () => undefined
    });
    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "cancelled" });
  });

  it("cancels when the turn stops and expires when the deadline passes", async () => {
    const cancel = vi.fn(async () => undefined);
    const stopped = await runSecureFormTool({
      args: definition,
      sessionId,
      pollMs: 1,
      pause: () => undefined,
      resume: () => undefined,
      create: async () => snapshot(),
      readStatus: async () => "pending",
      stopped: async () => true,
      cancel,
      expire: async () => undefined,
      approveDelivery: async () => true,
      deliver: async () => ({}),
      sleep: async () => undefined
    });
    expect(stopped.status).toBe("cancelled");
    expect(cancel).toHaveBeenCalledWith(formId);

    let now = Date.parse("2099-01-01T00:00:00.000Z");
    const expire = vi.fn(async () => undefined);
    const expired = await runSecureFormTool({
      args: definition,
      sessionId,
      pollMs: 1,
      pause: () => undefined,
      resume: () => undefined,
      create: async () => snapshot(),
      readStatus: async () => "pending",
      stopped: async () => false,
      cancel: async () => undefined,
      expire,
      approveDelivery: async () => true,
      deliver: async () => ({}),
      sleep: async () => undefined,
      now: () => now += 1
    });
    expect(expired.status).toBe("expired");
    expect(expire).toHaveBeenCalledWith(formId);
  });
});
