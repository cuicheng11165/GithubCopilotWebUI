import { describe, expect, it } from "vitest";
import { createStreamCursorState, eventTurnNotice, reducePermissions, reduceStreamEvent, sealTurnsWithAssistantMessages, visibleTurnNotice } from "./stream-state.js";

const turnId = "11111111-1111-4111-8111-111111111111";
const otherTurnId = "22222222-2222-4222-8222-222222222222";

describe("stream replay", () => {
  it("does not append deltas for a turn that already has an assistant message", () => {
    const sealed = sealTurnsWithAssistantMessages([
      { role: "user", turnId },
      { role: "assistant", turnId },
      { role: "assistant", turnId: null }
    ]);
    let state = createStreamCursorState(sealed);
    state = reduceStreamEvent(state, { cursor: 1, kind: "assistant.delta", turnId, data: { deltaContent: "Hello" } });
    state = reduceStreamEvent(state, { cursor: 2, kind: "assistant.delta", turnId, data: { deltaContent: " again" } });
    state = reduceStreamEvent(state, { cursor: 3, kind: "assistant.message", turnId, data: { content: "Hello again" } });
    expect(state.streaming).toBe("");
    expect(state.lastCursor).toBe(3);
  });

  it("replays an in-progress turn once and ignores a reconnect that restarts at cursor 0", () => {
    let state = createStreamCursorState();
    state = reduceStreamEvent(state, { cursor: 1, kind: "assistant.delta", turnId, data: { deltaContent: "Hello" } });
    state = reduceStreamEvent(state, { cursor: 2, kind: "assistant.delta", turnId, data: { deltaContent: " there" } });
    state = reduceStreamEvent(state, { cursor: 1, kind: "assistant.delta", turnId, data: { deltaContent: "Hello" } });
    state = reduceStreamEvent(state, { cursor: 2, kind: "assistant.delta", turnId, data: { deltaContent: " there" } });
    expect(state.streaming).toBe("Hello there");
    expect(state.streamingLive).toBe(true);
  });

  it("starts a new turn's text instead of concatenating it with the previous turn", () => {
    let state = createStreamCursorState();
    state = reduceStreamEvent(state, { cursor: 1, kind: "assistant.delta", turnId, data: { deltaContent: "First" } });
    state = reduceStreamEvent(state, { cursor: 2, kind: "turn.completed", turnId, data: {} });
    state = reduceStreamEvent(state, { cursor: 3, kind: "assistant.delta", turnId: otherTurnId, data: { deltaContent: "Second" } });
    expect(state.streaming).toBe("Second");
    expect(state.streamingTurnId).toBe(otherTurnId);
  });

  it("keeps partial text after a timeout without leaving it looking live", () => {
    let state = createStreamCursorState();
    state = reduceStreamEvent(state, { cursor: 1, kind: "assistant.delta", turnId, data: { deltaContent: "Partial" } });
    state = reduceStreamEvent(state, { cursor: 2, kind: "turn.timed_out", turnId, data: { error: "timed out" } });
    state = reduceStreamEvent(state, { cursor: 3, kind: "assistant.delta", turnId, data: { deltaContent: " more" } });
    expect(state.streaming).toBe("Partial");
    expect(state.streamingLive).toBe(false);
  });

  it("clears streaming when the final assistant message arrives", () => {
    let state = createStreamCursorState();
    state = reduceStreamEvent(state, { cursor: 1, kind: "assistant.delta", turnId, data: { deltaContent: "Hello" } });
    state = reduceStreamEvent(state, { cursor: 2, kind: "assistant.message", turnId, data: { content: "Hello" } });
    expect(state.streaming).toBe("");
    expect(state.sealedTurnIds.has(turnId)).toBe(true);
  });
});

describe("turn notices", () => {
  it("shows the latest timed-out or interrupted turn and hides it once a newer turn is active", () => {
    expect(visibleTurnNotice([
      { status: "failed", error: "old", createdAt: "2026-10-24T12:00:00.000Z" },
      { status: "timed-out", error: "This turn timed out after 900 seconds. Send a new message to continue.", createdAt: "2026-10-24T12:05:00.000Z" }
    ])).toEqual({ tone: "warning", message: "This turn timed out after 900 seconds. Send a new message to continue." });
    expect(visibleTurnNotice([
      { status: "interrupted", error: "Send a new message to retry.", createdAt: "2026-10-24T12:00:00.000Z" },
      { status: "queued", error: null, createdAt: "2026-10-24T12:06:00.000Z" }
    ])).toBeNull();
    expect(visibleTurnNotice([
      { status: "stopped", error: "You stopped this turn at the continue prompt. Send a new message if you want to keep going.", createdAt: "2026-10-24T12:07:00.000Z" }
    ])).toEqual({ tone: "warning", message: "You stopped this turn at the continue prompt. Send a new message if you want to keep going." });
    expect(visibleTurnNotice([
      { status: "stopped", error: null, createdAt: "2026-10-24T12:08:00.000Z" }
    ])).toBeNull();
    expect(eventTurnNotice("turn.interrupted", "Send a new message to retry.")?.tone).toBe("warning");
    expect(eventTurnNotice("turn.failed", "Model is not allowed")?.tone).toBe("error");
    expect(eventTurnNotice("turn.stopped", "You stopped this turn at the continue prompt.", "continue-checkpoint")?.message).toContain("continue prompt");
    expect(eventTurnNotice("turn.stopped", "The operation was aborted")).toBeNull();
  });
});

describe("permission replay", () => {
  it("keeps a single continue card when the pending prompt is loaded and the stream is replayed", () => {
    const pending = { id: "pending", scope: "continue", intention: "Continue this turn?" };
    let permissions = [pending];
    permissions = reducePermissions(permissions, { kind: "permission.requested", data: { id: "old", scope: "shell", intention: "Run tests" } });
    permissions = reducePermissions(permissions, { kind: "permission.completed", data: { requestId: "old", decision: "approve-once" } });
    permissions = reducePermissions(permissions, { kind: "permission.requested", data: pending });
    permissions = reducePermissions(permissions, { kind: "permission.requested", data: pending });
    expect(permissions).toEqual([pending]);
    permissions = reducePermissions(permissions, { kind: "permission.completed", data: { requestId: "pending", decision: "expired" } });
    expect(permissions).toEqual([]);
  });
});
