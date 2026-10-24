const recoverableStatuses = new Set(["RUNNING", "WAITING_APPROVAL"]);

export interface LeaseSnapshot {
  status: string;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}

/**
 * A turn is recoverable when another worker's lease is missing or due.
 * The current process never recovers its own lease here: a peer observes
 * the expiry, and a restart gets a new worker id.
 */
export function isExpiredForeignLease(turn: LeaseSnapshot, workerId: string, now: number): boolean {
  if (!recoverableStatuses.has(turn.status)) return false;
  if (turn.leaseOwner === workerId) return false;
  if (turn.leaseOwner === null || turn.leaseExpiresAt === null) return true;
  return turn.leaseExpiresAt.getTime() <= now;
}

export function expiredForeignLeaseWhere(workerId: string, now: Date) {
  return {
    status: { in: ["RUNNING", "WAITING_APPROVAL"] },
    OR: [
      { leaseOwner: null },
      {
        leaseOwner: { not: workerId },
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: now } }
        ]
      }
    ]
  };
}
