import { describe, expect, it, vi } from "vitest";
import { classifyPermissionPoll, CONTINUE_EXPIRED_MESSAGE, CONTINUE_STOPPED_MESSAGE, continueCheckpointCopy, INTERRUPTED_TURN_MESSAGE, SANDBOX_STOP_TIMEOUT_MS, sandboxRequestTimeoutMs, sdkTurnWaitMs, sessionStatusAfterInterrupt, TurnTimeoutError, turnTimeoutMessage, waitForTurn } from "./turn-control.js";

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

  it("does not count paused confirmation time against the turn timeout", async () => {
    const abort = vi.fn(async () => undefined);
    let resume: () => void = () => undefined;
    const pending = waitForTurn({
      timeoutMs: 40,
      send: () => new Promise(() => undefined),
      abort,
      onClock: (clock) => { clock.pause(); resume = () => clock.resume(); }
    });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(abort).not.toHaveBeenCalled();
    resume();
    await expect(pending).rejects.toBeInstanceOf(TurnTimeoutError);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("passes the extended SDK wait through while the local clock stays the turn limit", async () => {
    const send = vi.fn(async () => undefined);
    await waitForTurn({ timeoutMs: 1_000, sdkTimeoutMs: 5_000, send, abort: async () => undefined });
    expect(send).toHaveBeenCalledWith(5_000);
  });
});

describe("continue checkpoint timing", () => {
  it("extends the SDK wait only while checkpoints are enabled", () => {
    expect(sdkTurnWaitMs(15 * 60 * 1000, 300_000, false)).toBe(15 * 60 * 1000);
    expect(sdkTurnWaitMs(15 * 60 * 1000, 300_000, true)).toBe(15 * 60 * 1000 + 300_000 * 200);
  });

  it("describes continue and stop outcomes", () => {
    expect(continueCheckpointCopy(50)).toEqual({
      intention: "Continue this turn?",
      display: "The agent has completed 50 tool rounds. Choose Continue to keep going, or Stop to end this turn."
    });
    expect(CONTINUE_STOPPED_MESSAGE).toContain("stopped this turn");
    expect(CONTINUE_EXPIRED_MESSAGE).toContain("not answered");
  });
});

describe("permission poll classification", () => {
  it("treats stop, interrupt, timeout, and failure as cancellation rather than a card decision", () => {
    expect(classifyPermissionPoll("PENDING", "WAITING_APPROVAL")).toBe("pending");
    expect(classifyPermissionPoll("APPROVED", "WAITING_APPROVAL")).toBe("approved");
    expect(classifyPermissionPoll("DENIED", "WAITING_APPROVAL")).toBe("denied");
    expect(classifyPermissionPoll("EXPIRED", "WAITING_APPROVAL")).toBe("expired");
    expect(classifyPermissionPoll("DENIED", "STOPPED")).toBe("cancelled");
    expect(classifyPermissionPoll("PENDING", "INTERRUPTED")).toBe("cancelled");
    expect(classifyPermissionPoll("PENDING", "TIMED_OUT")).toBe("cancelled");
    expect(classifyPermissionPoll("PENDING", "FAILED")).toBe("cancelled");
    expect(classifyPermissionPoll("PENDING", null)).toBe("cancelled");
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
