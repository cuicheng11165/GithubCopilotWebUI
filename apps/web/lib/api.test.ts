import { afterEach, describe, expect, it, vi } from "vitest";
import { apiWrite } from "./api.js";

describe("apiWrite", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not declare an empty request body as JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiWrite("/api/auth/logout", "csrf-token", "POST");

    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRF-Token": "csrf-token" }
    });
  });

  it("sets the JSON content type when a body is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiWrite("/api/sessions", "csrf-token", "POST", { title: "Test" });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": "csrf-token"
      },
      body: JSON.stringify({ title: "Test" })
    });
  });
});
