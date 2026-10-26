import { describe, expect, it, vi } from "vitest";
import { postSandboxJson } from "./sandbox-client.js";

describe("sandbox requests", () => {
  it("sends JSON with a bearer token and an abort signal", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ bashId: "bash-1" }), { status: 200 }));
    await expect(postSandboxJson({
      baseUrl: "http://127.0.0.1:4100",
      token: "sandbox-token",
      pathname: "/bash",
      body: { command: "pwd" },
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as typeof fetch
    })).resolves.toEqual({ bashId: "bash-1" });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4100/bash");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sandbox-token");
    expect(init?.body).toBe(JSON.stringify({ command: "pwd" }));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts when the timeout elapses", async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        reject(error);
      });
    }));
    await expect(postSandboxJson({
      baseUrl: "http://127.0.0.1:4100",
      token: "sandbox-token",
      pathname: "/execute",
      body: { command: "sleep 30" },
      timeoutMs: 20,
      fetchImpl: fetchImpl as typeof fetch
    })).rejects.toThrow(/timeout/i);
  });

  it("surfaces sandbox error messages", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "Patch could not be applied" }), { status: 400 }));
    await expect(postSandboxJson({
      baseUrl: "http://127.0.0.1:4100",
      token: "sandbox-token",
      pathname: "/apply-patch",
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as typeof fetch
    })).rejects.toThrow("Patch could not be applied");
  });
});
