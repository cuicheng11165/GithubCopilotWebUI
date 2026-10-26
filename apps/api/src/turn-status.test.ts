import { describe, expect, it } from "vitest";
import { turnStatusName } from "./turn-status.js";

describe("turn status names", () => {
  it("uses hyphenated names the UI can match", () => {
    expect(turnStatusName("TIMED_OUT")).toBe("timed-out");
    expect(turnStatusName("INTERRUPTED")).toBe("interrupted");
    expect(turnStatusName("WAITING_APPROVAL")).toBe("waiting-approval");
    expect(turnStatusName("UNKNOWN")).toBe("failed");
  });
});
