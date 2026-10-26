export const INTERRUPTED_TURN_MESSAGE = "This turn was interrupted because the worker stopped or its lease expired. It was not restarted automatically. Send a new message to retry.";

export function turnTimeoutMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `This turn timed out after ${seconds} seconds. Send a new message to continue.`;
}

export class TurnTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(turnTimeoutMessage(timeoutMs));
    this.name = "TurnTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function isSdkTurnTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /timeout/i.test(`${error.name} ${error.message}`);
}

export interface TurnClock {
  pause(): void;
  resume(): void;
}

const terminalPermissionTurns = new Set(["STOPPED", "INTERRUPTED", "TIMED_OUT", "FAILED"]);

export type ManualPermissionPoll = "pending" | "approved" | "denied" | "expired" | "cancelled";

/** Turn cancellation wins over a permission row so stop and lease recovery are not treated as a card choice. */
export function classifyPermissionPoll(permissionStatus: string | null, turnStatus: string | null): ManualPermissionPoll {
  if (!turnStatus || terminalPermissionTurns.has(turnStatus)) return "cancelled";
  if (permissionStatus === "APPROVED") return "approved";
  if (permissionStatus === "DENIED") return "denied";
  if (permissionStatus === "EXPIRED") return "expired";
  return "pending";
}

export const CONTINUE_STOPPED_MESSAGE = "You stopped this turn at the continue prompt. Send a new message if you want to keep going.";
export const CONTINUE_EXPIRED_MESSAGE = "This turn stopped because the continue prompt was not answered before it expired. Send a new message if you want to keep going.";

export function continueCheckpointCopy(completedRounds: number): { intention: string; display: string } {
  const rounds = Math.max(1, Math.trunc(completedRounds));
  const noun = rounds === 1 ? "round" : "rounds";
  return {
    intention: "Continue this turn?",
    display: `The agent has completed ${rounds} tool ${noun}. Choose Continue to keep going, or Stop to end this turn.`
  };
}

const MAX_SDK_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
const CONTINUE_WAIT_ALLOWANCE = 200;

/** SDK idle wait must cover confirmation pauses. The turn clock itself excludes that time. */
export function sdkTurnWaitMs(turnTimeoutMs: number, approvalTimeoutMs: number, checkpointsEnabled: boolean): number {
  if (!checkpointsEnabled) return turnTimeoutMs;
  const allowance = Math.max(0, approvalTimeoutMs) * CONTINUE_WAIT_ALLOWANCE;
  const total = turnTimeoutMs + allowance;
  if (!Number.isFinite(total)) return MAX_SDK_WAIT_MS;
  return Math.min(MAX_SDK_WAIT_MS, Math.max(turnTimeoutMs, total));
}

export function createActiveTurnClock(budgetMs: number, now: () => number = Date.now): ActiveTurnClock {
  const startedAt = now();
  let pausedAt: number | null = null;
  let pausedMs = 0;
  let local = 0;
  let external = false;
  const sync = (at = now()) => {
    const shouldPause = local > 0 || external;
    if (shouldPause && pausedAt === null) pausedAt = at;
    if (!shouldPause && pausedAt !== null) {
      pausedMs += at - pausedAt;
      pausedAt = null;
    }
  };
  return {
    hold() { local += 1; sync(); },
    release() { local = Math.max(0, local - 1); sync(); },
    setExternal(paused: boolean) {
      if (external === paused) return;
      external = paused;
      sync();
    },
    isPaused() { return pausedAt !== null; },
    remainingMs(at = now()) {
      const live = pausedAt === null ? 0 : at - pausedAt;
      return budgetMs - (at - startedAt - pausedMs - live);
    }
  };
}

export interface ActiveTurnClock {
  hold(): void;
  release(): void;
  setExternal(paused: boolean): void;
  remainingMs(now?: number): number;
  isPaused(): boolean;
}

export function sdkTurnCeilingMs(turnTimeoutMs: number, pauseBudgetMs: number): number {
  return turnTimeoutMs + pauseBudgetMs;
}

export async function waitForTurn(input: {
  timeoutMs: number;
  sdkTimeoutMs?: number;
  send: (timeoutMs: number) => Promise<unknown>;
  abort: () => Promise<void>;
  onClock?: (clock: TurnClock) => void;
  clock?: ActiveTurnClock;
}): Promise<void> {
  if (input.clock) return waitWithActiveClock(input);
  return waitWithTurnClock(input);
}

async function waitWithTurnClock(input: {
  timeoutMs: number;
  sdkTimeoutMs?: number;
  send: (timeoutMs: number) => Promise<unknown>;
  abort: () => Promise<void>;
  onClock?: (clock: TurnClock) => void;
}): Promise<void> {
  let settled = false;
  let paused = false;
  let armed = false;
  let remaining = input.timeoutMs;
  let runningSince = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout: (error: TurnTimeoutError) => void = () => undefined;
  const abortOnce = () => {
    void input.abort().catch(() => undefined);
  };
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const expire = () => {
    if (settled || paused) return;
    settled = true;
    clearTimer();
    abortOnce();
    rejectTimeout(new TurnTimeoutError(input.timeoutMs));
  };
  const arm = () => {
    clearTimer();
    armed = true;
    runningSince = Date.now();
    timer = setTimeout(expire, Math.max(0, remaining));
  };
  const clock: TurnClock = {
    pause() {
      if (settled || paused) return;
      paused = true;
      if (armed) remaining -= Date.now() - runningSince;
      clearTimer();
    },
    resume() {
      if (settled || !paused) return;
      paused = false;
      if (remaining <= 0) expire();
      else arm();
    }
  };
  input.onClock?.(clock);
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  if (!paused) arm();
  const sendPromise = input.send(input.sdkTimeoutMs ?? input.timeoutMs).then(
    () => undefined,
    (error: unknown) => {
      if (settled) return undefined;
      if (error instanceof TurnTimeoutError || isSdkTurnTimeout(error)) {
        settled = true;
        abortOnce();
        throw new TurnTimeoutError(input.timeoutMs);
      }
      throw error;
    }
  );
  try {
    await Promise.race([sendPromise, timeoutPromise]);
    settled = true;
  } finally {
    clearTimer();
    void sendPromise.catch(() => undefined);
  }
}

async function waitWithActiveClock(input: {
  timeoutMs: number;
  sdkTimeoutMs?: number;
  send: (timeoutMs: number) => Promise<unknown>;
  abort: () => Promise<void>;
  onClock?: (clock: TurnClock) => void;
  clock?: ActiveTurnClock;
}): Promise<void> {
  const active = input.clock;
  if (!active) return waitWithTurnClock(input);
  let settled = false;
  let heldByTurnClock = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortOnce = () => {
    void input.abort().catch(() => undefined);
  };
  input.onClock?.({
    pause() {
      if (settled || heldByTurnClock) return;
      heldByTurnClock = true;
      active.hold();
    },
    resume() {
      if (settled || !heldByTurnClock) return;
      heldByTurnClock = false;
      active.release();
    }
  });
  const sendTimeout = input.sdkTimeoutMs ?? input.timeoutMs;
  const rejectSdkTimeout = (error: unknown): never => {
    if ((active.isPaused() || active.remainingMs() > 0) && (error instanceof TurnTimeoutError || isSdkTurnTimeout(error))) {
      settled = true;
      abortOnce();
      throw new Error("The agent runtime stopped while this turn was paused for approval or a secure form.");
    }
    if (error instanceof TurnTimeoutError || isSdkTurnTimeout(error)) {
      settled = true;
      abortOnce();
      throw new TurnTimeoutError(input.timeoutMs);
    }
    throw error;
  };
  const sendPromise = input.send(sendTimeout).then(
    () => undefined,
    (error: unknown) => {
      if (settled) return undefined;
      rejectSdkTimeout(error);
    }
  );
  try {
    await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) => {
        const check = () => {
          if (settled) return;
          if (active.isPaused()) {
            timer = setTimeout(check, 25);
            return;
          }
          const remaining = active.remainingMs();
          if (remaining <= 0) {
            settled = true;
            abortOnce();
            reject(new TurnTimeoutError(input.timeoutMs));
            return;
          }
          timer = setTimeout(check, Math.min(remaining, 25));
        };
        check();
      })
    ]);
    settled = true;
  } finally {
    if (timer) clearTimeout(timer);
    void sendPromise.catch(() => undefined);
  }
}

export function sessionStatusAfterInterrupt(activeStatuses: readonly string[]): "QUEUED" | "RUNNING" | "WAITING_APPROVAL" | "ERROR" {
  if (activeStatuses.includes("RUNNING")) return "RUNNING";
  if (activeStatuses.includes("WAITING_APPROVAL")) return "WAITING_APPROVAL";
  if (activeStatuses.includes("QUEUED")) return "QUEUED";
  return "ERROR";
}

export function sandboxRequestTimeoutMs(commandTimeoutSeconds: number, bufferSeconds: number): number {
  return (commandTimeoutSeconds + bufferSeconds) * 1000;
}

export const SANDBOX_STOP_TIMEOUT_MS = 15_000;
