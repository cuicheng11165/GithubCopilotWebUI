import { describe, expect, it, vi } from "vitest";
import { MemoryEphemeralStore } from "./ephemeral-store.js";

describe("MemoryEphemeralStore", () => {
  it("stores and consumes expiring values", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryEphemeralStore();
      await store.set("state", "github", 10);
      expect(await store.get("state")).toBe("github");
      expect(await store.take("state")).toBe("github");
      expect(await store.get("state")).toBeNull();

      await store.set("validation", "ok", 5);
      vi.advanceTimersByTime(5_001);
      expect(await store.get("validation")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
