/**
 * Counts agent tool rounds and asks once before the round that would pass the limit.
 * A round is one assistant message that requests one or more tools. Hook and handler
 * entry points share that count so a tool is not charged twice when both run.
 */
export class ToolRoundBudget {
  private nextRound = 0;
  private base = 0;
  private readonly queue: number[] = [];
  private confirming: Promise<boolean> | null = null;
  private stopped = false;
  private unmatchedHooks = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly confirm: (completedRounds: number) => Promise<boolean>
  ) {}

  get disabled(): boolean {
    return this.limit <= 0;
  }

  observeToolRound(toolCount: number): void {
    if (this.disabled || this.stopped || toolCount <= 0) return;
    this.nextRound += 1;
    for (let index = 0; index < toolCount; index += 1) this.queue.push(this.nextRound);
  }

  beforeHook(): Promise<boolean> {
    if (this.disabled) return Promise.resolve(true);
    return this.enqueue(async () => {
      const allowed = await this.beforeToolExclusive();
      if (allowed) this.unmatchedHooks += 1;
      return allowed;
    });
  }

  beforeHandler(): Promise<boolean> {
    if (this.disabled) return Promise.resolve(true);
    if (this.unmatchedHooks > 0) {
      this.unmatchedHooks -= 1;
      return Promise.resolve(!this.stopped);
    }
    return this.enqueue(() => this.beforeToolExclusive());
  }

  private enqueue(run: () => Promise<boolean>): Promise<boolean> {
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async beforeToolExclusive(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.queue.length === 0) await Promise.resolve();
    let round = this.queue.shift();
    if (round === undefined) {
      this.nextRound += 1;
      round = this.nextRound;
    }
    if (round - this.base <= this.limit) return true;
    const checkpointRound = round;
    if (!this.confirming) {
      const completedRounds = checkpointRound - this.base - 1;
      this.confirming = this.confirm(completedRounds).then((allowed) => {
        this.confirming = null;
        if (allowed) this.base = checkpointRound - 1;
        else this.stopped = true;
        return allowed;
      }, (error: unknown) => {
        this.confirming = null;
        this.stopped = true;
        throw error;
      });
    }
    return this.confirming;
  }
}
