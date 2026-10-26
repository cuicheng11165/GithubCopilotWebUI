import type { TurnStatus } from "@app/contracts";

const turnStatusNames: Record<string, TurnStatus> = {
  QUEUED: "queued",
  RUNNING: "running",
  WAITING_APPROVAL: "waiting-approval",
  COMPLETED: "completed",
  STOPPED: "stopped",
  FAILED: "failed",
  TIMED_OUT: "timed-out",
  INTERRUPTED: "interrupted"
};

export function turnStatusName(value: string): TurnStatus {
  return turnStatusNames[value] ?? "failed";
}
