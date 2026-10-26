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

export async function waitForTurn(input: {
  timeoutMs: number;
  send: (timeoutMs: number) => Promise<unknown>;
  abort: () => Promise<void>;
}): Promise<void> {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortOnce = () => {
    void input.abort().catch(() => undefined);
  };
  const sendPromise = input.send(input.timeoutMs).then(
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
    await Promise.race([
      sendPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          abortOnce();
          reject(new TurnTimeoutError(input.timeoutMs));
        }, input.timeoutMs);
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
