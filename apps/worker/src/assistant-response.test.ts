import { describe, expect, it } from "vitest";
import { lastAssistantContent } from "./assistant-response.js";

describe("lastAssistantContent", () => {
  it("uses the final assistant message after an intermediate tool preamble", () => {
    expect(lastAssistantContent([
      { type: "assistant.message", data: { content: "I will inspect the repository." } },
      { type: "tool.execution_start", data: {} },
      { type: "tool.execution_complete", data: {} },
      { type: "assistant.message", data: { content: "The repository has four skills." } }
    ])).toBe("The repository has four skills.");
  });

  it("ignores non-assistant events and preserves an empty final message", () => {
    expect(lastAssistantContent([
      { type: "assistant.message", data: { content: "Earlier response" } },
      { type: "assistant.message_delta", data: { content: "ignored" } },
      { type: "assistant.message", data: { content: "" } }
    ])).toBe("");
  });

  it("returns undefined when no assistant message exists", () => {
    expect(lastAssistantContent([{ type: "tool.execution_complete", data: {} }])).toBeUndefined();
  });
});
