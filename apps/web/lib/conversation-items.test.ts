import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@app/contracts";
import { groupConversationMessages } from "./conversation-items.js";

function message(id: string, role: ChatMessage["role"], turnId: string | null): ChatMessage {
  return {
    id,
    sessionId: "session",
    turnId,
    role,
    content: id,
    createdAt: "2026-07-23T00:00:00.000Z"
  };
}

describe("groupConversationMessages", () => {
  it("groups consecutive tool messages from the same turn", () => {
    const items = groupConversationMessages([
      message("user", "user", "turn-1"),
      message("tool-1", "tool", "turn-1"),
      message("tool-2", "tool", "turn-1"),
      message("assistant", "assistant", "turn-1")
    ]);

    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({
      kind: "tool-group",
      turnId: "turn-1",
      messages: [{ id: "tool-1" }, { id: "tool-2" }]
    });
  });

  it("keeps tools from different turns in separate groups", () => {
    const items = groupConversationMessages([
      message("tool-1", "tool", "turn-1"),
      message("tool-2", "tool", "turn-2")
    ]);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.kind === "tool-group" ? item.turnId : null)).toEqual(["turn-1", "turn-2"]);
  });

  it("preserves chronology when a non-tool message interrupts tool activity", () => {
    const items = groupConversationMessages([
      message("tool-1", "tool", "turn-1"),
      message("assistant", "assistant", "turn-1"),
      message("tool-2", "tool", "turn-1")
    ]);

    expect(items.map((item) => item.kind)).toEqual(["tool-group", "message", "tool-group"]);
  });
});
