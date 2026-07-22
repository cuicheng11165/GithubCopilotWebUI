import { z } from "zod";

export const approvalModeSchema = z.enum(["interactive", "session-scoped", "allow-all"]);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

export const approvalScopeSchema = z.enum(["shell", "url", "private-script"]);
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

export function shouldAutoApprove(mode: ApprovalMode, scopes: readonly ApprovalScope[], scope: ApprovalScope): boolean {
  return mode === "allow-all" || (mode === "session-scoped" && scopes.includes(scope));
}

export const sessionStatusSchema = z.enum(["idle", "queued", "running", "waiting-approval", "error"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const turnStatusSchema = z.enum(["queued", "running", "waiting-approval", "completed", "stopped", "failed"]);
export type TurnStatus = z.infer<typeof turnStatusSchema>;

export const repositorySummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  dirty: z.boolean(),
  skills: z.array(z.object({
    name: z.string(),
    description: z.string().nullable(),
    source: z.string(),
    warning: z.string().nullable()
  }))
});
export type RepositorySummary = z.infer<typeof repositorySummarySchema>;

export const sessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  repositoryId: z.string(),
  repositoryName: z.string(),
  model: z.string(),
  approvalMode: approvalModeSchema,
  approvalScopes: z.array(approvalScopeSchema),
  status: sessionStatusSchema,
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  dirty: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ChatSession = z.infer<typeof sessionSchema>;

export const createSessionSchema = z.object({
  repositoryId: z.string().min(1).max(100),
  model: z.string().min(1).max(100).default("auto"),
  approvalMode: approvalModeSchema.default("interactive"),
  approvalScopes: z.array(approvalScopeSchema).default([])
}).superRefine((value, context) => {
  if (value.approvalMode !== "session-scoped" && value.approvalScopes.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["approvalScopes"], message: "Scopes are only valid for session-scoped approval" });
  }
});
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const updateSessionSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  model: z.string().min(1).max(100).optional(),
  approvalMode: approvalModeSchema.optional(),
  approvalScopes: z.array(approvalScopeSchema).optional()
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(100_000)
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const permissionDecisionSchema = z.object({
  decision: z.enum(["approve-once", "deny"])
});
export type PermissionDecisionInput = z.infer<typeof permissionDecisionSchema>;

export const messageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const messageSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  role: messageRoleSchema,
  content: z.string(),
  createdAt: z.string().datetime()
});
export type ChatMessage = z.infer<typeof messageSchema>;

export const permissionRequestSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
  scope: approvalScopeSchema,
  intention: z.string(),
  display: z.string(),
  status: z.enum(["pending", "approved", "denied", "expired"]),
  expiresAt: z.string().datetime()
});
export type PermissionRequest = z.infer<typeof permissionRequestSchema>;

export const eventKindSchema = z.enum([
  "turn.queued",
  "turn.started",
  "assistant.delta",
  "assistant.message",
  "tool.started",
  "tool.completed",
  "permission.requested",
  "permission.completed",
  "repository.changed",
  "session.updated",
  "turn.completed",
  "turn.stopped",
  "turn.failed"
]);
export type EventKind = z.infer<typeof eventKindSchema>;

export const streamEventSchema = z.object({
  cursor: z.number().int().positive(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  kind: eventKindSchema,
  data: z.record(z.unknown()),
  createdAt: z.string().datetime()
});
export type StreamEvent = z.infer<typeof streamEventSchema>;

export interface AuthUser {
  id: string;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  provider: string;
  csrfToken: string;
}

export interface ModelSummary {
  id: string;
  name: string;
  supportsReasoning: boolean;
}

export const COPILOT_TURN_QUEUE = "copilot-turns";
export const COPILOT_CONTROL_QUEUE = "copilot-control";
export const SESSION_EVENT_CHANNEL_PREFIX = "session-events:";
export const PERMISSION_DECISION_CHANNEL_PREFIX = "permission-decisions:";
export const STOP_CHANNEL_PREFIX = "session-stop:";
