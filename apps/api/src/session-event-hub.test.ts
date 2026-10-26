import { describe, expect, it, vi } from "vitest";
import { createSessionEventHub, type HubEvent } from "./session-event-hub.js";

function event(cursor: number, sessionId: string, kind = "assistant.delta"): HubEvent {
  return { cursor, sessionId, turnId: "turn-1", kind, data: { deltaContent: `d${cursor}` }, createdAt: "2026-10-24T12:00:00.000Z" };
}

describe("session event hub", () => {
  it("publishes to the matching session once and keeps other sessions separate", () => {
    const hub = createSessionEventHub({ pollIntervalMs: 1_000, loadEvents: async () => [] });
    const first: number[] = [];
    const second: number[] = [];
    hub.subscribe("session-a", 0, (events) => first.push(...events.map((item) => item.cursor)));
    hub.subscribe("session-b", 0, (events) => second.push(...events.map((item) => item.cursor)));
    hub.publish([event(1, "session-a"), event(2, "session-b")]);
    hub.publish([event(1, "session-a"), event(3, "session-a")]);
    expect(first).toEqual([1, 3]);
    expect(second).toEqual([2]);
    hub.close();
  });

  it("loads worker events for subscribers and does not deliver cursors they already have", async () => {
    const rows = [event(4, "session-a"), event(5, "session-a"), event(9, "session-b")];
    const loadEvents = vi.fn(async (subscriptions: Array<{ sessionId: string; after: number }>) => {
      return rows.filter((row) => subscriptions.some((subscription) => subscription.sessionId === row.sessionId && row.cursor > subscription.after));
    });
    const hub = createSessionEventHub({ pollIntervalMs: 50, loadEvents });
    const seen: number[] = [];
    hub.subscribe("session-a", 4, (events) => seen.push(...events.map((item) => item.cursor)));
    hub.notify();
    await vi.waitFor(() => expect(seen).toEqual([5]));
    hub.notify();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toEqual([5]);
    hub.close();
  });
});
