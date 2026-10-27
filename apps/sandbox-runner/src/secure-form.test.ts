import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicSecureFormHookResponse, type SecureFormSnapshot } from "@app/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectHookDelivery, createSecureFormBridge, parseSecureFormCliArgs, SECURE_FORM_CLI_SOURCE, type SecureFormApi } from "./secure-form.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const sessionId = "22222222-2222-4222-8222-222222222222";
const formId = "11111111-1111-4111-8111-111111111111";

function snapshot(status: SecureFormSnapshot["status"], currentStep = status === "submitted" ? 2 : 0): SecureFormSnapshot {
  return {
    id: formId,
    sessionId,
    turnId: "33333333-3333-4333-8333-333333333333",
    title: "Sign in to Microsoft",
    subtitle: "Secure form",
    targetSite: "login.microsoftonline.com",
    purpose: "Open SharePoint",
    steps: [
      { id: "email", kind: "input", fields: [{ name: "email", label: "Email", type: "email", required: true }] },
      { id: "password", kind: "input", fields: [{ name: "password", label: "Password", type: "password", required: true }] }
    ],
    currentStep,
    status,
    expiresAt: "2099-01-01T00:00:00.000Z"
  };
}

describe("secure form command hook", () => {
  it("parses ordered email, password, and approve steps", () => {
    const parsed = parseSecureFormCliArgs([
      "--title", "Sign in to Microsoft",
      "--target", "login.microsoftonline.com",
      "--purpose", "Open SharePoint",
      "--field", "email:email:Work email",
      "--field", "password:password:Password",
      "--confirm", "approve:Approve on your phone, then continue",
      "--each-step"
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.command.op !== "request") throw new Error("expected a request");
    expect(parsed.command.mode).toBe("each-step");
    expect(parsed.command.definition.steps.map((step) => step.kind)).toEqual(["input", "input", "confirm"]);
    expect(parsed.command.definition.steps[1]?.fields[0]?.type).toBe("password");
    expect(parseSecureFormCliArgs(["--not-a-flag"]).ok).toBe(false);
  });

  it("does not claim values when the command only opens a form", async () => {
    const claim = vi.fn();
    const api: SecureFormApi = {
      create: async () => snapshot("pending", 0),
      read: async () => snapshot("submitted"),
      claim,
      claimStep: async () => { throw new Error("no step"); },
      cancel: async () => undefined,
      expire: async () => undefined
    };
    const outcome = await collectHookDelivery({
      sessionId,
      definition: snapshot("pending").steps.length ? {
        title: "Sign in to Microsoft",
        targetSite: "login.microsoftonline.com",
        purpose: "Open SharePoint",
        steps: snapshot("pending").steps
      } : snapshot("pending"),
      mode: "final",
      consume: false,
      api,
      sleep: async () => undefined
    });
    expect(outcome.status).toBe("submitted");
    expect(outcome.delivery).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
    expect(JSON.stringify(publicSecureFormHookResponse({ status: outcome.status, fieldNames: outcome.fieldNames, ...(outcome.formId ? { formId: outcome.formId } : {}) }))).not.toContain("hunter2");
  });

  it("claims each submitted step for stdin and keeps values out of the public result", async () => {
    const seen: string[] = [];
    const api: SecureFormApi = {
      create: async () => snapshot("pending", 0),
      read: async () => snapshot("submitted"),
      claim: async () => { throw new Error("final claim"); },
      claimStep: async (_session, _form, stepId) => ({
        id: stepId,
        kind: "input",
        values: { [stepId]: stepId === "password" ? "hunter2" : "ada@example.com" }
      }),
      cancel: async () => undefined,
      expire: async () => undefined
    };
    const outcome = await collectHookDelivery({
      sessionId,
      definition: {
        title: "Sign in to Microsoft",
        targetSite: "login.microsoftonline.com",
        purpose: "Open SharePoint",
        steps: snapshot("pending").steps
      },
      mode: "each-step",
      consume: true,
      api,
      sleep: async () => undefined,
      onStep: (step) => { seen.push(step.values?.password ?? step.values?.email ?? ""); }
    });
    expect(seen).toEqual(["ada@example.com", "hunter2"]);
    expect(outcome.delivery?.steps[1]?.values?.password).toBe("hunter2");
    const published = publicSecureFormHookResponse({ status: outcome.status, fieldNames: outcome.fieldNames, delivered: true, ...(outcome.formId ? { formId: outcome.formId } : {}) });
    expect(JSON.stringify(published)).not.toContain("hunter2");
    expect(published).not.toHaveProperty("values");
  });

  it("exposes only the socket and helper path to the command", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "secure-form-hook-"));
    directories.push(directory);
    const bridge = createSecureFormBridge({
      api: {
        create: async () => snapshot("submitted"),
        read: async () => snapshot("submitted"),
        claim: async () => { throw new Error("unused"); },
        claimStep: async () => { throw new Error("unused"); },
        cancel: async () => undefined,
        expire: async () => undefined
      },
      beginStdin: () => { throw new Error("unused"); },
      runWithStdin: async () => { throw new Error("unused"); }
    });
    const attached = await bridge.attach({
      sessionId,
      tempDirectory: directory,
      repositoryPath: directory,
      timeoutSeconds: 2,
      maxOutputBytes: 1024,
      controls: { pauseTimeout() {}, resumeTimeout() {}, redact() {} }
    });
    expect(Object.keys(attached.env).sort()).toEqual(["COPILOT_SECURE_FORM_BIN", "COPILOT_SECURE_FORM_SOCKET"]);
    expect(JSON.stringify(attached.env)).not.toContain("TOKEN");
    await attached.close();
  });

  it("passes the Microsoft login CLI path without service tokens", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "secure-form-hook-"));
    directories.push(directory);
    const bridge = createSecureFormBridge({
      api: {
        create: async () => snapshot("submitted"),
        read: async () => snapshot("submitted"),
        claim: async () => { throw new Error("unused"); },
        claimStep: async () => { throw new Error("unused"); },
        cancel: async () => undefined,
        expire: async () => undefined
      },
      beginStdin: () => { throw new Error("unused"); },
      runWithStdin: async () => { throw new Error("unused"); },
      extraEnv: {
        MS_LOGIN_CLI: "/opt/ms-login/cli.js",
        PLAYWRIGHT_BROWSERS_PATH: "/opt/ms-playwright",
        SANDBOX_RUNNER_TOKEN: "super-secret-token"
      }
    });
    const attached = await bridge.attach({
      sessionId,
      tempDirectory: directory,
      repositoryPath: directory,
      timeoutSeconds: 2,
      maxOutputBytes: 1024,
      controls: { pauseTimeout() {}, resumeTimeout() {}, redact() {} }
    });
    expect(Object.keys(attached.env).sort()).toEqual([
      "COPILOT_SECURE_FORM_BIN",
      "COPILOT_SECURE_FORM_SOCKET",
      "MS_LOGIN_CLI",
      "PLAYWRIGHT_BROWSERS_PATH"
    ]);
    expect(attached.env.MS_LOGIN_CLI).toBe("/opt/ms-login/cli.js");
    expect(JSON.stringify(attached.env)).not.toContain("TOKEN");
    expect(JSON.stringify(attached.env)).not.toContain("super-secret-token");
    await attached.close();
  });

  it("strips secret fields from a hook response before printing it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "secure-form-cli-"));
    directories.push(directory);
    const socketPath = path.join(directory, "hook.sock");
    const binPath = path.join(directory, "secure-form.mjs");
    await writeFile(binPath, SECURE_FORM_CLI_SOURCE, { mode: 0o700 });
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.end(`${JSON.stringify({ status: "submitted", values: { password: "hunter2" }, steps: [{ values: { password: "hunter2" } }], stdout: "ok" })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      const child = spawn(process.execPath, [binPath, "--title", "Sign in"], {
        env: { ...process.env, COPILOT_SECURE_FORM_SOCKET: socketPath }
      });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      const [code] = await once(child, "exit") as [number | null];
      expect(code).toBe(0);
      expect(output).toContain("\"status\":\"submitted\"");
      expect(output).not.toContain("hunter2");
      expect(output).not.toContain("values");
      expect(output).not.toContain("steps");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
