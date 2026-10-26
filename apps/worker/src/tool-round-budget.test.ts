import { describe, expect, it, vi } from "vitest";
import { ToolRoundBudget } from "./tool-round-budget.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function runRound(budget: ToolRoundBudget, tools: number, entry: "hook" | "handler" = "hook"): Promise<boolean[]> {
  budget.observeToolRound(tools);
  const results: boolean[] = [];
  for (let index = 0; index < tools; index += 1) {
    const allowed = entry === "hook" ? await budget.beforeHook() : await budget.beforeHandler();
    if (entry === "hook") await budget.beforeHandler();
    results.push(allowed);
  }
  return results;
}

describe("tool round budget", () => {
  it("does nothing when the limit is disabled", async () => {
    const confirm = vi.fn(async () => true);
    const budget = new ToolRoundBudget(0, confirm);
    budget.observeToolRound(4);
    await expect(budget.beforeHook()).resolves.toBe(true);
    await expect(budget.beforeHandler()).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks after the configured number of rounds and resets the counter on continue", async () => {
    const confirm = vi.fn(async () => true);
    const budget = new ToolRoundBudget(2, confirm);
    await runRound(budget, 1);
    await runRound(budget, 3);
    expect(confirm).not.toHaveBeenCalled();

    budget.observeToolRound(2);
    await Promise.all([budget.beforeHook(), budget.beforeHook()]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(2);

    await runRound(budget, 1);
    expect(confirm).toHaveBeenCalledTimes(1);
    await runRound(budget, 1);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith(2);
  });

  it("charges a tool once when both the hook and the handler run", async () => {
    const confirm = vi.fn(async () => true);
    const budget = new ToolRoundBudget(1, confirm);
    await runRound(budget, 1);
    await runRound(budget, 1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("counts handler-only tools when the runtime does not invoke hooks", async () => {
    const confirm = vi.fn(async () => false);
    const budget = new ToolRoundBudget(1, confirm);
    await expect(runRound(budget, 1, "handler")).resolves.toEqual([true]);
    await expect(runRound(budget, 1, "handler")).resolves.toEqual([false]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("stops later tools after the user declines", async () => {
    const confirm = vi.fn(async () => false);
    const budget = new ToolRoundBudget(1, confirm);
    await runRound(budget, 1);
    budget.observeToolRound(1);
    await expect(budget.beforeHook()).resolves.toBe(false);
    budget.observeToolRound(4);
    await expect(budget.beforeHandler()).resolves.toBe(false);
    await expect(budget.beforeHook()).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("shares one confirmation across every tool in the round", async () => {
    const gate = deferred<boolean>();
    const confirm = vi.fn(() => gate.promise);
    const budget = new ToolRoundBudget(1, confirm);
    await runRound(budget, 1);
    budget.observeToolRound(2);
    const pending = Promise.all([budget.beforeHook(), budget.beforeHook()]);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    gate.resolve(true);
    await expect(pending).resolves.toEqual([true, true]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
