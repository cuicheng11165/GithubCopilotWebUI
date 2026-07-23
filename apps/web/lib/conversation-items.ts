import type { ChatMessage } from "@app/contracts";

export type ConversationItem =
  | { kind: "message"; key: string; message: ChatMessage }
  | { kind: "tool-group"; key: string; turnId: string | null; messages: ChatMessage[] };

export function groupConversationMessages(messages: ChatMessage[]): ConversationItem[] {
  const items: ConversationItem[] = [];

  for (const message of messages) {
    const previous = items[items.length - 1];
    if (message.role === "tool") {
      if (previous?.kind === "tool-group" && previous.turnId === message.turnId) {
        previous.messages.push(message);
      } else {
        items.push({
          kind: "tool-group",
          key: `tools:${message.turnId ?? message.id}`,
          turnId: message.turnId,
          messages: [message]
        });
      }
    } else {
      items.push({ kind: "message", key: message.id, message });
    }
  }

  return items;
}
