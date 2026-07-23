export interface SessionEventLike {
  type: string;
  data?: { content?: unknown };
}

export function lastAssistantContent(events: readonly SessionEventLike[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "assistant.message" && typeof event.data?.content === "string") return event.data.content;
  }
  return undefined;
}
