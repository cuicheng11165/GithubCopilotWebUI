import type { TurnSummary } from "@app/contracts";

export interface StreamCursorState {
  lastCursor: number;
  streaming: string;
  streamingTurnId: string | null;
  streamingLive: boolean;
  sealedTurnIds: Set<string>;
}

export interface StreamEventInput {
  cursor?: number;
  kind: string;
  turnId: string | null;
  data?: Record<string, unknown>;
}

const sealOn = new Set(["assistant.message", "turn.completed", "turn.failed", "turn.stopped", "turn.timed_out", "turn.interrupted"]);

export function createStreamCursorState(sealedTurnIds: Iterable<string> = []): StreamCursorState {
  return { lastCursor: 0, streaming: "", streamingTurnId: null, streamingLive: false, sealedTurnIds: new Set(sealedTurnIds) };
}

export function sealTurnsWithAssistantMessages(messages: Array<{ role: string; turnId: string | null }>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.turnId) ids.add(message.turnId);
  }
  return ids;
}

export function reduceStreamEvent(state: StreamCursorState, event: StreamEventInput): StreamCursorState {
  if (typeof event.cursor !== "number" || !Number.isInteger(event.cursor) || event.cursor <= state.lastCursor) return state;
  const sealedTurnIds = new Set(state.sealedTurnIds);
  let streaming = state.streaming;
  let streamingTurnId = state.streamingTurnId;
  let streamingLive = state.streamingLive;
  if (event.kind === "assistant.delta" && event.turnId && !sealedTurnIds.has(event.turnId)) {
    const delta = String(event.data?.deltaContent ?? "");
    if (streamingTurnId !== event.turnId) {
      streaming = delta;
      streamingTurnId = event.turnId;
    } else streaming += delta;
    streamingLive = true;
  }
  if (event.kind === "assistant.message" && event.turnId && streamingTurnId === event.turnId) {
    streaming = "";
    streamingTurnId = null;
    streamingLive = false;
  } else if (event.turnId && streamingTurnId === event.turnId && sealOn.has(event.kind)) streamingLive = false;
  if (event.turnId && sealOn.has(event.kind)) sealedTurnIds.add(event.turnId);
  return { lastCursor: event.cursor, streaming, streamingTurnId, streamingLive, sealedTurnIds };
}

const noticeTone: Record<string, "warning" | "error"> = {
  "timed-out": "warning",
  interrupted: "warning",
  failed: "error",
  stopped: "warning"
};

export function reducePermissions<T extends { id: string }>(current: readonly T[], event: { kind: string; data?: Record<string, unknown> }): T[] {
  if (event.kind === "permission.requested") {
    const id = typeof event.data?.id === "string" ? event.data.id : "";
    if (!id) return [...current];
    return [...current.filter((item) => item.id !== id), event.data as T];
  }
  if (event.kind === "permission.completed") {
    const requestId = typeof event.data?.requestId === "string" ? event.data.requestId : "";
    if (!requestId) return [...current];
    return current.filter((item) => item.id !== requestId);
  }
  return [...current];
}

export function visibleTurnNotice(turns: Array<Pick<TurnSummary, "status" | "error" | "createdAt">>): { tone: "warning" | "error"; message: string } | null {
  const latest = [...turns].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
  if (!latest?.error) return null;
  const tone = noticeTone[latest.status];
  if (!tone) return null;
  return { tone, message: latest.error };
}

export function eventTurnNotice(kind: string, error: unknown, reason?: unknown): { tone: "warning" | "error"; message: string } | null {
  if (kind === "turn.stopped") {
    if (reason !== "continue-checkpoint") return null;
    const message = typeof error === "string" && error.trim() ? error : "This turn stopped at the continue prompt.";
    return { tone: "warning", message };
  }
  if (kind !== "turn.timed_out" && kind !== "turn.interrupted" && kind !== "turn.failed") return null;
  const message = typeof error === "string" && error.trim() ? error : kind === "turn.timed_out"
    ? "This turn timed out. Send a new message to continue."
    : kind === "turn.interrupted"
      ? "This turn was interrupted. Send a new message to retry."
      : "This turn failed.";
  return { tone: kind === "turn.failed" ? "error" : "warning", message };
}
