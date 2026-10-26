import { z } from "zod";

export const secureFormFieldTypeSchema = z.enum(["text", "email", "password", "otp"]);
export type SecureFormFieldType = z.infer<typeof secureFormFieldTypeSchema>;

export const secureFormStepKindSchema = z.enum(["input", "confirm"]);
export type SecureFormStepKind = z.infer<typeof secureFormStepKindSchema>;

export const secureFormStatusSchema = z.enum(["pending", "submitted", "cancelled", "expired"]);
export type SecureFormStatusName = z.infer<typeof secureFormStatusSchema>;

export const secureFormDeliveryModeSchema = z.enum(["final", "each-step"]);
export type SecureFormDeliveryMode = z.infer<typeof secureFormDeliveryModeSchema>;

const fieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);
const stepIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/);

export const secureFormFieldSchema = z.object({
  name: fieldNameSchema,
  label: z.string().trim().min(1).max(80),
  type: secureFormFieldTypeSchema,
  purpose: z.string().trim().min(1).max(200).optional(),
  required: z.boolean().optional()
});

export const secureFormStepSchema = z.object({
  id: stepIdSchema,
  kind: secureFormStepKindSchema,
  title: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().trim().min(1).max(400).optional(),
  fields: z.array(secureFormFieldSchema).max(8).optional()
});

export const secureFormDefinitionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().min(1).max(80).optional(),
  targetSite: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(400),
  steps: z.array(secureFormStepSchema).min(1).max(6)
});

export const secureFormCreateBodySchema = secureFormDefinitionSchema.extend({
  sessionId: z.string().uuid()
});

export const secureFormClaimBodySchema = z.object({
  sessionId: z.string().uuid()
});

export const secureFormClaimStepBodySchema = secureFormClaimBodySchema.extend({
  stepId: stepIdSchema
});

export const secureFormLifecycleBodySchema = z.object({
  sessionId: z.string().uuid(),
  turnId: z.string().uuid().optional(),
  reason: z.string().trim().min(1).max(80)
});

export const secureFormDiscardBodySchema = z.object({
  formIds: z.array(z.string().uuid()).max(100)
});

export const secureFormToolInputSchema = secureFormDefinitionSchema.extend({
  deliveryCommand: z.string().trim().min(1).max(100_000).optional(),
  deliveryMode: secureFormDeliveryModeSchema.optional()
});

export const secureFormSubmitSchema = z.object({
  stepId: stepIdSchema,
  confirmed: z.boolean().optional(),
  values: z.record(fieldNameSchema, z.string().max(4_096)).optional()
});

export interface SecureFormField {
  name: string;
  label: string;
  type: SecureFormFieldType;
  purpose?: string;
  required: boolean;
}

export interface SecureFormStep {
  id: string;
  kind: SecureFormStepKind;
  title?: string;
  prompt?: string;
  fields: SecureFormField[];
}

export interface SecureFormDefinition {
  title: string;
  subtitle?: string;
  targetSite: string;
  purpose: string;
  steps: SecureFormStep[];
}

export interface SecureFormSnapshot extends SecureFormDefinition {
  id: string;
  sessionId: string;
  turnId: string;
  subtitle: string;
  currentStep: number;
  status: SecureFormStatusName;
  expiresAt: string;
}

export interface SecureFormToolInput extends SecureFormDefinition {
  deliveryCommand?: string;
  deliveryMode?: SecureFormDeliveryMode;
}

export interface SecureFormStepDelivery {
  id: string;
  kind: SecureFormStepKind;
  values?: Record<string, string>;
  confirmed?: boolean;
}

export interface SecureFormDelivery {
  formId: string;
  targetSite: string;
  purpose: string;
  steps: SecureFormStepDelivery[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECRET_RESULT_KEYS = /^(?:values|value|password|secret|otp|token|code|pin|passcode|credential|credentials)$/i;
const SECRET_PAYLOAD_KEYS = /^(?:authorization|cookie|set-cookie|token|accessToken|refreshToken|apiKey|secret|password|clientSecret|privateKey|otp|passcode|pin|mfaCode|verificationCode|credential|credentials|values|value|secureFormValues)$/i;

function normalizeField(field: z.infer<typeof secureFormFieldSchema>): SecureFormField {
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    ...(field.purpose ? { purpose: field.purpose } : {}),
    required: field.required !== false
  };
}

function normalizeStep(step: z.infer<typeof secureFormStepSchema>): SecureFormStep {
  return {
    id: step.id,
    kind: step.kind,
    ...(step.title ? { title: step.title } : {}),
    ...(step.prompt ? { prompt: step.prompt } : {}),
    fields: (step.fields ?? []).map(normalizeField)
  };
}

function validateSteps(steps: readonly SecureFormStep[], context: z.RefinementCtx, path: (string | number)[]): void {
  const seen = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (seen.has(step.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index, "id"], message: "Step ids must be unique" });
    }
    seen.add(step.id);
    const fieldNames = new Set<string>();
    for (const [fieldIndex, field] of step.fields.entries()) {
      if (fieldNames.has(field.name)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index, "fields", fieldIndex, "name"], message: "Field names must be unique within a step" });
      }
      fieldNames.add(field.name);
    }
    if (step.kind === "confirm" && step.fields.length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index, "fields"], message: "A confirmation step cannot collect fields" });
    }
    if (step.kind === "input" && step.fields.length === 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index, "fields"], message: "An input step needs at least one field" });
    }
  }
}

export function parseSecureFormDefinition(input: unknown): SecureFormDefinition {
  const parsed = secureFormDefinitionSchema.parse(input);
  const definition: SecureFormDefinition = {
    title: parsed.title,
    ...(parsed.subtitle ? { subtitle: parsed.subtitle } : {}),
    targetSite: parsed.targetSite,
    purpose: parsed.purpose,
    steps: parsed.steps.map(normalizeStep)
  };
  const issues: z.ZodIssue[] = [];
  validateSteps(definition.steps, { addIssue: (issue) => issues.push(issue as z.ZodIssue), path: [] }, ["steps"]);
  if (issues.length > 0) throw new z.ZodError(issues);
  return definition;
}

export function parseSecureFormToolInput(input: unknown): SecureFormToolInput {
  const parsed = secureFormToolInputSchema.parse(input);
  const definition = parseSecureFormDefinition(parsed);
  return {
    ...definition,
    ...(parsed.deliveryCommand ? { deliveryCommand: parsed.deliveryCommand } : {}),
    ...(parsed.deliveryMode ? { deliveryMode: parsed.deliveryMode } : {})
  };
}

export function parseStoredSecureFormSteps(input: unknown): SecureFormStep[] {
  const parsed = z.array(secureFormStepSchema).min(1).max(6).parse(input).map(normalizeStep);
  const issues: z.ZodIssue[] = [];
  validateSteps(parsed, { addIssue: (issue) => issues.push(issue as z.ZodIssue), path: [] }, []);
  if (issues.length > 0) throw new z.ZodError(issues);
  return parsed;
}

export function secureFormStatusName(status: string): SecureFormStatusName {
  const map: Record<string, SecureFormStatusName> = {
    PENDING: "pending",
    SUBMITTED: "submitted",
    CANCELLED: "cancelled",
    EXPIRED: "expired",
    pending: "pending",
    submitted: "submitted",
    cancelled: "cancelled",
    expired: "expired"
  };
  const name = map[status];
  if (!name) throw new Error("Unknown secure form status");
  return name;
}

export const secureFormSnapshotSchema = secureFormDefinitionSchema.extend({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
  subtitle: z.string().min(1).max(80),
  currentStep: z.number().int().nonnegative(),
  status: secureFormStatusSchema,
  expiresAt: z.string().datetime()
});

export function parseSecureFormSnapshot(input: unknown): SecureFormSnapshot | null {
  const parsed = secureFormSnapshotSchema.safeParse(input);
  if (!parsed.success) return null;
  try {
    return toSecureFormSnapshot(parsed.data);
  } catch {
    return null;
  }
}

export function toSecureFormSnapshot(row: {
  id: string;
  sessionId: string;
  turnId: string;
  title: string;
  subtitle: string;
  targetSite: string;
  purpose: string;
  steps: unknown;
  currentStep: number;
  status: string;
  expiresAt: Date | string;
}): SecureFormSnapshot {
  const steps = parseStoredSecureFormSteps(row.steps);
  const definition = parseSecureFormDefinition({
    title: row.title,
    subtitle: row.subtitle,
    targetSite: row.targetSite,
    purpose: row.purpose,
    steps
  });
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    title: definition.title,
    subtitle: definition.subtitle ?? "Secure form",
    targetSite: definition.targetSite,
    purpose: definition.purpose,
    steps: definition.steps,
    currentStep: row.currentStep,
    status: secureFormStatusName(row.status),
    expiresAt: row.expiresAt instanceof Date ? row.expiresAt.toISOString() : new Date(row.expiresAt).toISOString()
  };
}

export type SecureFormAdvance =
  | {
      ok: true;
      currentStep: number;
      status: "pending" | "submitted";
      stepId: string;
      values: Record<string, string>;
      fieldNames: string[];
      confirmed: boolean;
    }
  | { ok: false; error: string };

export function advanceSecureForm(input: {
  steps: readonly SecureFormStep[];
  currentStep: number;
  submission: z.infer<typeof secureFormSubmitSchema>;
}): SecureFormAdvance {
  if (!Number.isInteger(input.currentStep) || input.currentStep < 0 || input.currentStep >= input.steps.length) {
    return { ok: false, error: "This secure form step is no longer available" };
  }
  const step = input.steps[input.currentStep];
  if (!step || step.id !== input.submission.stepId) {
    return { ok: false, error: "Submit the current secure form step" };
  }
  if (step.kind === "confirm") {
    if (input.submission.confirmed !== true) return { ok: false, error: "Confirm this step to continue" };
    if (input.submission.values && Object.keys(input.submission.values).length > 0) {
      return { ok: false, error: "A confirmation step does not accept field values" };
    }
    const currentStep = input.currentStep + 1;
    return {
      ok: true,
      currentStep,
      status: currentStep >= input.steps.length ? "submitted" : "pending",
      stepId: step.id,
      values: {},
      fieldNames: [],
      confirmed: true
    };
  }
  const provided = input.submission.values ?? {};
  const allowed = new Set(step.fields.map((field) => field.name));
  for (const name of Object.keys(provided)) {
    if (!allowed.has(name)) return { ok: false, error: "Unknown secure form field" };
  }
  const values: Record<string, string> = {};
  for (const field of step.fields) {
    const raw = provided[field.name];
    const normalized = raw === undefined ? "" : field.type === "password" ? raw : raw.trim();
    if (field.required && normalized.length === 0) return { ok: false, error: `${field.label} is required` };
    if (normalized.length === 0) continue;
    if (normalized.length > 2_048) return { ok: false, error: `${field.label} is too long` };
    if (field.type === "email" && !EMAIL_PATTERN.test(normalized)) return { ok: false, error: `Enter a valid ${field.label}` };
    values[field.name] = normalized;
  }
  const currentStep = input.currentStep + 1;
  return {
    ok: true,
    currentStep,
    status: currentStep >= input.steps.length ? "submitted" : "pending",
    stepId: step.id,
    values,
    fieldNames: Object.keys(values),
    confirmed: false
  };
}

const terminalStatus = new Set<SecureFormStatusName>(["submitted", "cancelled", "expired"]);

export function mergeSecureFormSnapshot(current: readonly SecureFormSnapshot[], next: SecureFormSnapshot): SecureFormSnapshot[] {
  const index = current.findIndex((item) => item.id === next.id);
  if (index < 0) return [...current, next];
  const previous = current[index];
  if (!previous) return [...current, next];
  if (terminalStatus.has(previous.status) && previous.status !== next.status) return current.slice();
  if (next.currentStep < previous.currentStep) return current.slice();
  if (next.currentStep === previous.currentStep && terminalStatus.has(previous.status) && !terminalStatus.has(next.status)) return current.slice();
  const copy = current.slice();
  copy[index] = next;
  return copy;
}

export interface SecureFormCardModel {
  key: string;
  form: SecureFormSnapshot;
  step: SecureFormStep;
  stepIndex: number;
  state: "open" | "submitted" | "cancelled" | "expired";
}

export function visibleSecureFormCards(form: SecureFormSnapshot): SecureFormCardModel[] {
  const revealed = form.status === "submitted" ? form.steps.length : Math.min(form.currentStep + 1, form.steps.length);
  const cards: SecureFormCardModel[] = [];
  for (let index = 0; index < revealed; index += 1) {
    const step = form.steps[index];
    if (!step) continue;
    const state = index < form.currentStep || form.status === "submitted"
      ? "submitted"
      : form.status === "pending"
        ? "open"
        : form.status;
    cards.push({ key: `${form.id}:${step.id}`, form, step, stepIndex: index, state });
  }
  return cards;
}

export function redactSecretText(text: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length > 0))].sort((left, right) => right.length - left.length);
  let output = text;
  for (const secret of unique) output = output.split(secret).join("[redacted]");
  return output;
}

export function collectSecretValues(delivery: SecureFormDelivery): string[] {
  const secrets: string[] = [];
  for (const step of delivery.steps) {
    for (const value of Object.values(step.values ?? {})) secrets.push(value);
  }
  return secrets;
}

export function assertModelSafeSecureFormResult(result: Record<string, unknown>): void {
  for (const key of Object.keys(result)) {
    if (SECRET_RESULT_KEYS.test(key)) throw new Error(`Refusing to return '${key}' to the model`);
  }
}

export function secureFormModelResult(input: {
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
  const result: Record<string, unknown> = { status: input.status };
  if (input.formId) result.formId = input.formId;
  if (input.delivered !== undefined) result.delivered = input.delivered;
  if (input.fieldNames) result.fieldNames = input.fieldNames;
  if (input.exitCode !== undefined) result.exitCode = input.exitCode;
  if (input.stdout !== undefined) result.stdout = input.stdout;
  if (input.stderr !== undefined) result.stderr = input.stderr;
  if (input.timedOut !== undefined) result.timedOut = input.timedOut;
  if (input.reason) result.reason = input.reason;
  assertModelSafeSecureFormResult(result);
  return result;
}

export function sanitizeDeliveryReport(input: unknown): {
  delivered: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
} {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return {
    delivered: record.delivered === true,
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    timedOut: record.timedOut === true
  };
}

export function redactSecureFormToolPayload(value: unknown): unknown {
  return redactPayload(value, 0);
}

function redactPayload(value: unknown, depth: number): unknown {
  if (depth > 12) return "[Maximum depth reached]";
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    SECRET_PAYLOAD_KEYS.test(key) ? "[Redacted]" : redactPayload(entry, depth + 1)
  ]));
}

export function publicSecureFormHookResponse(input: {
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
  return secureFormModelResult(input);
}
