import {
  parseSecureFormToolInput,
  secureFormModelResult,
  sanitizeDeliveryReport,
  type SecureFormDeliveryMode,
  type SecureFormSnapshot,
  type SecureFormToolInput
} from "@app/contracts";

export function secureFormPauseBudgetMs(secureFormTimeoutSeconds: number, approvalTimeoutSeconds: number): number {
  return (secureFormTimeoutSeconds + approvalTimeoutSeconds) * 1000 * 8;
}

export async function postWorkerJson<T>(input: {
  baseUrl: string;
  token: string;
  pathname: string;
  body?: unknown;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const init: RequestInit = {
    method: "POST",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000)
  };
  if (input.body !== undefined) init.body = JSON.stringify(input.body);
  const response = await fetchImpl(`${input.baseUrl}${input.pathname}`, init);
  const result = await response.json().catch(() => ({ error: response.statusText })) as T & { error?: string };
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error.slice(0, 200) : "Secure form request failed");
  return result;
}

function safeReason(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/\s+/g, " ").slice(0, 200) || fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSecureFormTool(input: {
  args: unknown;
  sessionId: string;
  pollMs: number;
  pause: () => void;
  resume: () => void;
  create: (body: SecureFormToolInput & { sessionId: string }) => Promise<SecureFormSnapshot>;
  readStatus: (formId: string) => Promise<SecureFormSnapshot["status"] | "missing">;
  stopped: () => Promise<boolean>;
  cancel: (formId: string) => Promise<void>;
  expire: (formId: string) => Promise<void>;
  approveDelivery: (command: string) => Promise<boolean>;
  deliver: (formId: string, command: string, mode: SecureFormDeliveryMode) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<Record<string, unknown>> {
  let request: SecureFormToolInput;
  try {
    request = parseSecureFormToolInput(input.args);
  } catch {
    return secureFormModelResult({ status: "failed", reason: "The secure form schema was invalid" });
  }
  const wait = input.sleep ?? sleep;
  const now = input.now ?? Date.now;
  const mode = request.deliveryMode ?? "final";
  input.pause();
  try {
    if (request.deliveryCommand) {
      const approved = await input.approveDelivery(request.deliveryCommand);
      if (!approved) return secureFormModelResult({ status: "cancelled", reason: "The delivery command was not approved" });
    }
    let created: SecureFormSnapshot;
    try {
      created = await input.create({ ...request, sessionId: input.sessionId });
    } catch (error) {
      return secureFormModelResult({ status: "failed", reason: safeReason(error, "The secure form could not be opened") });
    }
    const deadline = Date.parse(created.expiresAt);
    let status: SecureFormSnapshot["status"] | "missing" = "pending";
    while (now() < deadline) {
      if (await input.stopped()) {
        await input.cancel(created.id).catch(() => undefined);
        return secureFormModelResult({ status: "cancelled", formId: created.id, reason: "The turn was stopped" });
      }
      status = await input.readStatus(created.id);
      if (status === "submitted") break;
      if (status === "cancelled") return secureFormModelResult({ status: "cancelled", formId: created.id });
      if (status === "expired" || status === "missing") return secureFormModelResult({ status: "expired", formId: created.id });
      await wait(input.pollMs);
    }
    if (status !== "submitted") {
      await input.expire(created.id).catch(() => undefined);
      return secureFormModelResult({ status: "expired", formId: created.id });
    }
    const fieldNames = created.steps.flatMap((step) => step.fields.map((field) => field.name));
    if (!request.deliveryCommand) return secureFormModelResult({ status: "submitted", formId: created.id, delivered: false, fieldNames });
    input.resume();
    try {
      const report = sanitizeDeliveryReport(await input.deliver(created.id, request.deliveryCommand, mode));
      return secureFormModelResult({
        status: "submitted",
        formId: created.id,
        delivered: report.delivered,
        fieldNames,
        exitCode: report.exitCode,
        stdout: report.stdout,
        stderr: report.stderr,
        timedOut: report.timedOut,
        ...(report.delivered ? {} : { reason: "Secure form values could not be delivered" })
      });
    } catch {
      return secureFormModelResult({ status: "submitted", formId: created.id, delivered: false, fieldNames, reason: "Secure form values could not be delivered" });
    }
  } finally {
    input.resume();
  }
}
