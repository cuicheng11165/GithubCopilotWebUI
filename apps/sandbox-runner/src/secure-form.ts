import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  collectSecretValues,
  parseSecureFormDefinition,
  publicSecureFormHookResponse,
  type SecureFormDefinition,
  type SecureFormDelivery,
  type SecureFormDeliveryMode,
  type SecureFormSnapshot,
  type SecureFormStepDelivery
} from "@app/contracts";
import type { ExecutionInput, ExecutionResult, StdinExecution } from "./execution.js";

const FIELD_TYPES = new Set(["text", "email", "password", "otp"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SecureFormApi {
  create(body: SecureFormDefinition & { sessionId: string }): Promise<SecureFormSnapshot>;
  read(sessionId: string, formId: string): Promise<SecureFormSnapshot>;
  claim(sessionId: string, formId: string): Promise<SecureFormDelivery>;
  claimStep(sessionId: string, formId: string, stepId: string): Promise<SecureFormStepDelivery>;
  cancel(sessionId: string, formId: string, reason: string): Promise<void>;
  expire(sessionId: string, formId: string, reason: string): Promise<void>;
}

export type SecureFormCliCommand =
  | { op: "request"; definition: SecureFormDefinition; exec?: string; mode: SecureFormDeliveryMode }
  | { op: "claim"; formId: string; exec: string };

export function parseSecureFormCliArgs(argv: readonly string[]): { ok: true; command: SecureFormCliCommand } | { ok: false; error: string } {
  let title = "";
  let targetSite = "";
  let purpose = "";
  let subtitle: string | undefined;
  let exec: string | undefined;
  let formId: string | undefined;
  let mode: SecureFormDeliveryMode = "final";
  let stepsJson: unknown;
  const steps: Array<Record<string, unknown>> = [];
  const take = (index: number): { value?: string; error?: string } => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return { error: "A secure form flag is missing its value" };
    return { value };
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--each-step") {
      mode = "each-step";
      continue;
    }
    const read = take(index);
    if (read.error || read.value === undefined) return { ok: false, error: read.error ?? "A secure form flag is missing its value" };
    const value = read.value;
    index += 1;
    if (flag === "--title") title = value;
    else if (flag === "--target") targetSite = value;
    else if (flag === "--purpose") purpose = value;
    else if (flag === "--subtitle") subtitle = value;
    else if (flag === "--exec") exec = value;
    else if (flag === "--form") formId = value;
    else if (flag === "--steps") {
      try { stepsJson = JSON.parse(value) as unknown; }
      catch { return { ok: false, error: "The secure form steps JSON was invalid" }; }
    } else if (flag === "--field") {
      const parts = value.split(":");
      if (parts.length < 3) return { ok: false, error: "A field needs name:type:label" };
      const name = parts[0] ?? "";
      const type = parts[1] ?? "";
      const label = parts.slice(2).join(":");
      if (!FIELD_TYPES.has(type)) return { ok: false, error: "Unknown secure form field type" };
      steps.push({ id: name, kind: "input", fields: [{ name, label, type: type as "text" | "email" | "password" | "otp" }] });
    } else if (flag === "--confirm") {
      const separator = value.indexOf(":");
      const id = separator === -1 ? value : value.slice(0, separator);
      const prompt = separator === -1 ? "Continue" : value.slice(separator + 1);
      steps.push({ id, kind: "confirm", fields: [], ...(prompt ? { prompt } : {}) });
    } else return { ok: false, error: "Unknown secure form flag" };
  }
  if (formId) {
    if (!UUID_PATTERN.test(formId)) return { ok: false, error: "Invalid secure form id" };
    if (!exec) return { ok: false, error: "A claim needs a command that reads stdin" };
    return { ok: true, command: { op: "claim", formId, exec } };
  }
  try {
    const definition = parseSecureFormDefinition({
      title,
      targetSite,
      purpose,
      ...(subtitle ? { subtitle } : {}),
      steps: stepsJson ?? steps
    });
    return { ok: true, command: { op: "request", definition, mode, ...(exec ? { exec } : {}) } };
  } catch {
    return { ok: false, error: "The secure form schema was invalid" };
  }
}

function fieldNamesOf(definition: Pick<SecureFormDefinition, "steps">): string[] {
  return definition.steps.flatMap((step) => step.fields.map((field) => field.name));
}

export async function collectHookDelivery(input: {
  sessionId: string;
  definition: SecureFormDefinition;
  mode: SecureFormDeliveryMode;
  consume: boolean;
  api: SecureFormApi;
  onStep?: (step: SecureFormStepDelivery) => Promise<void> | void;
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
}): Promise<{ status: "submitted" | "cancelled" | "expired" | "failed"; delivery?: SecureFormDelivery; fieldNames: string[]; formId?: string; reason?: string }> {
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const pollMs = input.pollMs ?? 200;
  const names = fieldNamesOf(input.definition);
  let created: SecureFormSnapshot;
  try {
    created = await input.api.create({ ...input.definition, sessionId: input.sessionId });
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 200) : "The secure form could not be opened";
    return { status: "failed", fieldNames: names, reason };
  }
  const deadline = Date.parse(created.expiresAt);
  const claimed = new Map<string, SecureFormStepDelivery>();
  const claimReady = async (snapshot: SecureFormSnapshot) => {
    if (input.mode !== "each-step" || !input.consume) return null;
    for (let index = 0; index < snapshot.currentStep && index < snapshot.steps.length; index += 1) {
      const step = snapshot.steps[index];
      if (!step || claimed.has(step.id)) continue;
      let delivered: SecureFormStepDelivery | undefined;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          delivered = await input.api.claimStep(input.sessionId, created.id, step.id);
          break;
        } catch {
          await sleep(pollMs);
        }
      }
      if (!delivered) {
        await input.api.cancel(input.sessionId, created.id, "delivery-failed").catch(() => undefined);
        return { status: "failed" as const, fieldNames: names, formId: created.id, reason: "A secure form step could not be delivered" };
      }
      claimed.set(step.id, delivered);
      try {
        await input.onStep?.(delivered);
      } catch {
        await input.api.cancel(input.sessionId, created.id, "delivery-failed").catch(() => undefined);
        return { status: "failed" as const, fieldNames: names, formId: created.id, reason: "The delivery command stopped" };
      }
    }
    return null;
  };
  while (now() < deadline) {
    if (input.shouldStop?.()) {
      await input.api.cancel(input.sessionId, created.id, "stopped").catch(() => undefined);
      return { status: "cancelled", fieldNames: names, formId: created.id, reason: "The command was stopped" };
    }
    let snapshot: SecureFormSnapshot;
    try {
      snapshot = await input.api.read(input.sessionId, created.id);
    } catch {
      return { status: "expired", fieldNames: names, formId: created.id };
    }
    const failed = await claimReady(snapshot);
    if (failed) return failed;
    if (snapshot.status === "cancelled") return { status: "cancelled", fieldNames: names, formId: created.id };
    if (snapshot.status === "expired") return { status: "expired", fieldNames: names, formId: created.id };
    if (snapshot.status === "submitted") {
      if (input.mode === "each-step" && input.consume) {
        const steps = snapshot.steps.map((step) => claimed.get(step.id)).filter((step): step is SecureFormStepDelivery => Boolean(step));
        if (steps.length !== snapshot.steps.length) {
          return { status: "failed", fieldNames: names, formId: created.id, reason: "A secure form step could not be delivered" };
        }
        return { status: "submitted", fieldNames: names, formId: created.id, delivery: { formId: created.id, targetSite: snapshot.targetSite, purpose: snapshot.purpose, steps } };
      }
      if (!input.consume) return { status: "submitted", fieldNames: names, formId: created.id };
      try {
        const delivery = await input.api.claim(input.sessionId, created.id);
        return { status: "submitted", fieldNames: names, formId: created.id, delivery };
      } catch {
        return { status: "failed", fieldNames: names, formId: created.id, reason: "Secure form values could not be delivered" };
      }
    }
    await sleep(pollMs);
  }
  await input.api.expire(input.sessionId, created.id, "timeout").catch(() => undefined);
  return { status: "expired", fieldNames: names, formId: created.id };
}

export function createSecureFormApi(input: { baseUrl: string; token: string; fetchImpl?: typeof fetch }): SecureFormApi {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const fetchImpl = input.fetchImpl ?? fetch;
  const request = async <T>(pathname: string, method: "GET" | "POST", body?: unknown): Promise<T> => {
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${input.token}`, "Cache-Control": "no-store" },
      signal: AbortSignal.timeout(20_000)
    };
    if (body !== undefined) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(`${baseUrl}${pathname}`, init);
    const parsed = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(typeof parsed.error === "string" ? parsed.error.slice(0, 200) : "Secure form request failed");
    return parsed as T;
  };
  return {
    create: (body) => request("/internal/secure-forms", "POST", body),
    read: (sessionId, formId) => request(`/internal/secure-forms/${formId}?sessionId=${encodeURIComponent(sessionId)}`, "GET"),
    claim: (sessionId, formId) => request(`/internal/secure-forms/${formId}/claim`, "POST", { sessionId }),
    claimStep: (sessionId, formId, stepId) => request(`/internal/secure-forms/${formId}/claim-step`, "POST", { sessionId, stepId }),
    cancel: async (sessionId, formId, reason) => { await request(`/internal/secure-forms/${formId}/cancel`, "POST", { sessionId, reason }); },
    expire: async (sessionId, formId, reason) => { await request(`/internal/secure-forms/${formId}/expire`, "POST", { sessionId, reason }); }
  };
}

export const SECURE_FORM_CLI_SOURCE = `#!/usr/bin/env node
import { createConnection } from "node:net";
import { argv, env, exit, stdout } from "node:process";

function emit(value) {
  const record = value && typeof value === "object" ? value : {};
  const result = {};
  if (typeof record.status === "string") result.status = record.status;
  if (typeof record.formId === "string") result.formId = record.formId;
  if (typeof record.delivered === "boolean") result.delivered = record.delivered;
  if (Array.isArray(record.fieldNames)) result.fieldNames = record.fieldNames.filter((item) => typeof item === "string");
  if (typeof record.exitCode === "number" || record.exitCode === null) result.exitCode = record.exitCode;
  if (typeof record.stdout === "string") result.stdout = record.stdout;
  if (typeof record.stderr === "string") result.stderr = record.stderr;
  if (typeof record.timedOut === "boolean") result.timedOut = record.timedOut;
  if (typeof record.reason === "string") result.reason = record.reason;
  stdout.write(JSON.stringify(result) + "\\n");
  exit(result.status === "submitted" ? 0 : 1);
}

const socketPath = env.COPILOT_SECURE_FORM_SOCKET;
if (!socketPath) emit({ status: "failed", reason: "Secure form hook is unavailable" });
const socket = createConnection(socketPath);
let buffer = "";
socket.on("error", () => emit({ status: "failed", reason: "Secure form hook is unavailable" }));
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const newline = buffer.indexOf("\\n");
  if (newline < 0) {
    if (buffer.length > 1024 * 1024) emit({ status: "failed", reason: "Secure form response was too large" });
    return;
  }
  try { emit(JSON.parse(buffer.slice(0, newline))); }
  catch { emit({ status: "failed", reason: "Invalid secure form response" }); }
});
socket.write(JSON.stringify({ argv: argv.slice(2) }) + "\\n");
`;

function published(input: {
  status: "submitted" | "cancelled" | "expired" | "failed";
  formId?: string;
  delivered?: boolean;
  fieldNames?: string[];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  reason?: string;
}): Record<string, unknown> {
  return publicSecureFormHookResponse(input);
}

function executionInput(base: {
  sessionId: string;
  repositoryPath: string;
  tempDirectory: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
}, command: string): ExecutionInput {
  return {
    sessionId: base.sessionId,
    command,
    repositoryPath: base.repositoryPath,
    tempRoot: path.dirname(base.tempDirectory),
    timeoutSeconds: base.timeoutSeconds,
    maxOutputBytes: base.maxOutputBytes
  };
}

function hookEnvironment(extra: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  if (!extra) return {};
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!value) continue;
    if (/TOKEN|SECRET|PASSWORD|COOKIE/i.test(key)) continue;
    result[key] = value;
  }
  return result;
}

export function createSecureFormBridge(options: {
  api: SecureFormApi;
  beginStdin: (input: ExecutionInput) => StdinExecution;
  runWithStdin: (input: ExecutionInput & { stdin: string; secrets?: readonly string[] }) => Promise<ExecutionResult>;
  pollMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
}) {
  return {
    async attach(input: {
      sessionId: string;
      tempDirectory: string;
      repositoryPath: string;
      timeoutSeconds: number;
      maxOutputBytes: number;
      controls: { pauseTimeout(): void; resumeTimeout(): void; redact(secrets: readonly string[]): void };
    }) {
      const socketPath = process.platform === "win32"
        ? `\\\\.\\pipe\\copilot-secure-form-${randomUUID()}`
        : path.join(input.tempDirectory, "secure-form.sock");
      const binPath = path.join(input.tempDirectory, "secure-form.mjs");
      await writeFile(binPath, SECURE_FORM_CLI_SOURCE, { mode: 0o700 });
      if (process.platform !== "win32") await chmod(binPath, 0o700);
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        let buffer = "";
        let settled = false;
        let abandon = () => undefined as void;
        const finish = (response: Record<string, unknown>) => {
          settled = true;
          if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
        };
        socket.on("error", () => { if (!settled) abandon(); });
        socket.on("close", () => { if (!settled) abandon(); });
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          if (buffer.length > 256 * 1024) {
            finish(published({ status: "failed", reason: "Secure form request was too large" }));
            return;
          }
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          buffer = "";
          void handleSocketLine(line, {
            ...input,
            api: options.api,
            beginStdin: options.beginStdin,
            runWithStdin: options.runWithStdin,
            pollMs: options.pollMs ?? 200,
            bindAbandon: (callback) => { abandon = callback; }
          }).then(finish).catch(() => finish(published({ status: "failed", reason: "Secure form request failed" })));
        });
      });
      try {
        if (process.platform !== "win32") await rm(socketPath, { force: true });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => resolve());
        });
        if (process.platform !== "win32") await chmod(socketPath, 0o600);
      } catch (error) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
      }
      const env: NodeJS.ProcessEnv = {
        ...hookEnvironment(options.extraEnv),
        COPILOT_SECURE_FORM_SOCKET: socketPath,
        COPILOT_SECURE_FORM_BIN: binPath
      };
      return {
        env,
        async close() {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      };
    }
  };
}

async function handleSocketLine(line: string, input: {
  sessionId: string;
  tempDirectory: string;
  repositoryPath: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  controls: { pauseTimeout(): void; resumeTimeout(): void; redact(secrets: readonly string[]): void };
  api: SecureFormApi;
  beginStdin: (request: ExecutionInput) => StdinExecution;
  runWithStdin: (request: ExecutionInput & { stdin: string; secrets?: readonly string[] }) => Promise<ExecutionResult>;
  pollMs: number;
  bindAbandon: (callback: () => void) => void;
}): Promise<Record<string, unknown>> {
  let payload: { argv?: unknown };
  try { payload = JSON.parse(line) as { argv?: unknown }; }
  catch { return published({ status: "failed", reason: "Invalid secure form request" }); }
  if (!Array.isArray(payload.argv) || payload.argv.some((item) => typeof item !== "string")) {
    return published({ status: "failed", reason: "Invalid secure form request" });
  }
  const parsed = parseSecureFormCliArgs(payload.argv);
  if (!parsed.ok) return published({ status: "failed", reason: parsed.error });
  if (parsed.command.op === "claim") {
    try {
      const delivery = await input.api.claim(input.sessionId, parsed.command.formId);
      const secrets = collectSecretValues(delivery);
      input.controls.redact(secrets);
      const result = await input.runWithStdin({
        ...executionInput(input, parsed.command.exec),
        stdin: `${JSON.stringify(delivery)}\n`,
        secrets
      });
      return published({
        status: "submitted",
        formId: parsed.command.formId,
        delivered: result.exitCode === 0 && !result.timedOut,
        fieldNames: delivery.steps.flatMap((step) => Object.keys(step.values ?? {})),
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        ...(result.exitCode === 0 && !result.timedOut ? {} : { reason: "Secure form values could not be delivered" })
      });
    } catch {
      return published({ status: "failed", formId: parsed.command.formId, delivered: false, reason: "Secure form values could not be delivered" });
    }
  }
  const command = parsed.command;
  let stopped = false;
  let child: StdinExecution | undefined;
  input.bindAbandon(() => {
    stopped = true;
    child?.cancel();
  });
  input.controls.pauseTimeout();
  try {
    const execCommand = command.exec;
    const onStep = command.mode === "each-step" && execCommand ? async (step: SecureFormStepDelivery) => {
      if (!child) {
        child = input.beginStdin(executionInput(input, execCommand));
        child.pauseTimeout();
      }
      const secrets = Object.values(step.values ?? {});
      child.addSecrets(secrets);
      input.controls.redact(secrets);
      const lineBody = step.kind === "confirm"
        ? { id: step.id, kind: step.kind, confirmed: true }
        : { id: step.id, kind: step.kind, values: step.values ?? {} };
      child.write(`${JSON.stringify(lineBody)}\n`);
    } : undefined;
    const outcome = await collectHookDelivery({
      sessionId: input.sessionId,
      definition: command.definition,
      mode: command.mode,
      consume: Boolean(execCommand),
      api: input.api,
      pollMs: input.pollMs,
      shouldStop: () => stopped || Boolean(child && childExited(child)),
      ...(onStep ? { onStep } : {})
    });
    input.controls.resumeTimeout();
    child?.resumeTimeout();
    if (outcome.status !== "submitted" || !command.exec) {
      child?.cancel();
      return published({
        status: outcome.status,
        ...(outcome.formId ? { formId: outcome.formId } : {}),
        delivered: false,
        fieldNames: outcome.fieldNames,
        ...(outcome.reason ? { reason: outcome.reason } : {})
      });
    }
    if (!outcome.delivery) {
      child?.cancel();
      return published({ status: "failed", ...(outcome.formId ? { formId: outcome.formId } : {}), delivered: false, fieldNames: outcome.fieldNames, reason: outcome.reason ?? "Secure form values could not be delivered" });
    }
    const secrets = collectSecretValues(outcome.delivery);
    input.controls.redact(secrets);
    if (command.mode === "each-step") {
      if (!child) child = input.beginStdin(executionInput(input, command.exec));
      child.addSecrets(secrets);
      child.end();
      const result = await child.finished;
      return published({
        status: "submitted",
        ...(outcome.formId ? { formId: outcome.formId } : {}),
        delivered: result.exitCode === 0 && !result.timedOut,
        fieldNames: outcome.fieldNames,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        ...(result.exitCode === 0 && !result.timedOut ? {} : { reason: "Secure form values could not be delivered" })
      });
    }
    const result = await input.runWithStdin({
      ...executionInput(input, command.exec),
      stdin: `${JSON.stringify(outcome.delivery)}\n`,
      secrets
    });
    return published({
      status: "submitted",
      ...(outcome.formId ? { formId: outcome.formId } : {}),
      delivered: result.exitCode === 0 && !result.timedOut,
      fieldNames: outcome.fieldNames,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      ...(result.exitCode === 0 && !result.timedOut ? {} : { reason: "Secure form values could not be delivered" })
    });
  } finally {
    input.controls.resumeTimeout();
    child?.resumeTimeout();
  }
}

const exited = new WeakMap<StdinExecution, boolean>();
const watched = new WeakSet<StdinExecution>();

function childExited(child: StdinExecution): boolean {
  if (exited.get(child)) return true;
  if (!watched.has(child)) {
    watched.add(child);
    void child.finished.then(() => { exited.set(child, true); }, () => { exited.set(child, true); });
  }
  return false;
}
