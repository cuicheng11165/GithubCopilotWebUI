import type { AuthUser, ChatMessage, ChatSession, ModelSummary, PermissionRequest, RepositorySummary } from "@app/contracts";

export interface SessionDetail {
  session: ChatSession;
  messages: ChatMessage[];
  permissions: PermissionRequest[];
  skills: Array<{ name: string; description: string | null; source: string; warning: string | null; contentHash?: string }>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function parse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string } & T;
  if (!response.ok) throw new ApiError(body.error ?? "Request failed", response.status);
  return body;
}

export async function apiGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { credentials: "include", cache: "no-store" }));
}

export async function apiWrite<T>(path: string, csrfToken: string, method: "POST" | "PATCH" | "DELETE", body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, ...extraHeaders }
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return parse<T>(await fetch(path, init));
}

export const getMe = () => apiGet<AuthUser>("/api/me");
export const getRuntime = () => apiGet<{ sandboxBackend: "local" | "container" }>("/api/runtime");
export const getRepositories = () => apiGet<RepositorySummary[]>("/api/repositories");
export const getModels = () => apiGet<ModelSummary[]>("/api/models");
export const getSessions = () => apiGet<ChatSession[]>("/api/sessions");
export const getSession = (id: string) => apiGet<SessionDetail>(`/api/sessions/${id}`);
