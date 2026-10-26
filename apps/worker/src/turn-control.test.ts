import { describe, expect, it, vi } from "vitest";
import { INTERRUPTED_TURN_MESSAGE, SANDBOX_STOP_TIMEOUT_MS, sandboxRequestTimeoutMs, sessionStatusAfterInterrupt, TurnTimeoutError, turnTimeoutMessage, waitForTurn } from "./turn-control.js";

describe("turn timeout", () => {
  it("describes the configured limit", () => {
    expect(turnTimeoutMessage(15 * 60 * 1000)).toBe("This turn timed out after 900 seconds. Send a new message to continue.");
    expect(INTERRUPTED_TURN_MESSAGE).toContain("not restarted automatically");
  });

  it("aborts the session when the turn exceeds the timeout", async () => {
    const abort = vi.fn(async () => undefined);
    await expect(waitForTurn({
      timeoutMs: 20,
      send: () => new Promise(() => undefined),
      abort
    })).rejects.toBeInstanceOf(TurnTimeoutError);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("treats the Copilot SDK timeout as a turn timeout and stops the session", async () => {
    const abort = vi.fn(async () => undefined);
    const error = new Error("Timeout after 900000ms waiting for session.idle");
    await expect(waitForTurn({
      timeoutMs: 1_000,
      send: async () => { throw error; },
      abort
    })).rejects.toMatchObject({ name: "TurnTimeoutError", message: turnTimeoutMessage(1_000) });
    expect(abort).toHaveBeenCalledOnce();
  });

  it("returns normally when the session finishes first", async () => {
    const abort = vi.fn(async () => undefined);
    await expect(waitForTurn({ timeoutMs: 1_000, send: async () => "done", abort })).resolves.toBeUndefined();
    expect(abort).not.toHaveBeenCalled();
  });
});

describe("lease recovery status", () => {
  it("keeps queued work runnable and otherwise surfaces an error", () => {
    expect(sessionStatusAfterInterrupt(["QUEUED"])).toBe("QUEUED");
    expect(sessionStatusAfterInterrupt(["RUNNING", "QUEUED"])).toBe("RUNNING");
    expect(sessionStatusAfterInterrupt(["WAITING_APPROVAL"])).toBe("WAITING_APPROVAL");
    expect(sessionStatusAfterInterrupt([])).toBe("ERROR");
  });
});

describe("sandbox request timeout", () => {
  it("waits at least as long as the command timeout", () => {
    expect(sandboxRequestTimeoutMs(120, 15)).toBe(135_000);
    expect(SANDBOX_STOP_TIMEOUT_MS).toBeLessThan(sandboxRequestTimeoutMs(120, 15));
  });
});
