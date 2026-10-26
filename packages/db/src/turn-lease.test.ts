import { describe, expect, it } from "vitest";
import { isExpiredForeignLease, type LeaseSnapshot } from "./turn-lease.js";

const now = Date.parse("2026-10-24T12:00:00.000Z");

function turn(overrides: Partial<LeaseSnapshot> = {}): LeaseSnapshot {
  return {
    status: "RUNNING",
    leaseOwner: "worker-b",
    leaseExpiresAt: new Date(now - 1_000),
    ...overrides
  };
}

describe("expired foreign leases", () => {
  it("recovers another worker's expired or missing lease", () => {
    expect(isExpiredForeignLease(turn(), "worker-a", now)).toBe(true);
    expect(isExpiredForeignLease(turn({ leaseExpiresAt: null }), "worker-a", now)).toBe(true);
    expect(isExpiredForeignLease(turn({ leaseOwner: null, leaseExpiresAt: new Date(now + 60_000) }), "worker-a", now)).toBe(true);
    expect(isExpiredForeignLease(turn({ status: "WAITING_APPROVAL" }), "worker-a", now)).toBe(true);
  });

  it("leaves live peers and this worker's own turns alone", () => {
    expect(isExpiredForeignLease(turn({ leaseExpiresAt: new Date(now + 30_000) }), "worker-a", now)).toBe(false);
    expect(isExpiredForeignLease(turn({ leaseOwner: "worker-a", leaseExpiresAt: new Date(now - 1_000) }), "worker-a", now)).toBe(false);
    expect(isExpiredForeignLease(turn({ leaseOwner: "worker-a", leaseExpiresAt: null }), "worker-a", now)).toBe(false);
  });

  it("ignores terminal turns", () => {
    for (const status of ["QUEUED", "COMPLETED", "FAILED", "STOPPED", "TIMED_OUT", "INTERRUPTED"]) {
      expect(isExpiredForeignLease(turn({ status }), "worker-a", now)).toBe(false);
    }
  });
});
