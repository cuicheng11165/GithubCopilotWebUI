import { describe, expect, it, vi } from "vitest";
import { accessTokenNeedsRefresh, exchangeOAuthRefreshToken, resolveGitHubAccessToken, type GitHubAccountTokenRecord, type GitHubTokenStore, type GitHubTokenUpdate } from "./github-access-token.js";

function record(overrides: Partial<GitHubAccountTokenRecord> = {}): GitHubAccountTokenRecord {
  return {
    id: "account-1",
    provider: "github",
    host: "github.com",
    encryptedAccessToken: "enc-access",
    encryptedRefreshToken: "enc-refresh",
    accessTokenExpiresAt: new Date(Date.now() + 60_000),
    refreshTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshClaimedBy: null,
    refreshClaimedUntil: null,
    ...overrides
  };
}

class MemoryTokenStore implements GitHubTokenStore {
  constructor(public current: GitHubAccountTokenRecord) {}

  async find(id: string) {
    return id === this.current.id ? { ...this.current } : null;
  }

  async claim(input: { id: string; encryptedRefreshToken: string; owner: string; until: Date; now: Date }) {
    if (this.current.id !== input.id || this.current.encryptedRefreshToken !== input.encryptedRefreshToken) return false;
    const held = this.current.refreshClaimedUntil !== null && this.current.refreshClaimedUntil.getTime() > input.now.getTime() && this.current.refreshClaimedBy !== input.owner;
    if (held) return false;
    this.current.refreshClaimedBy = input.owner;
    this.current.refreshClaimedUntil = input.until;
    return true;
  }

  async save(input: { id: string; owner: string; update: GitHubTokenUpdate }) {
    if (this.current.id !== input.id || this.current.refreshClaimedBy !== input.owner) return false;
    this.apply(input.update);
    return true;
  }

  async saveIfRefreshTokenMatches(input: { id: string; encryptedRefreshToken: string; update: GitHubTokenUpdate }) {
    if (this.current.id !== input.id || this.current.encryptedRefreshToken !== input.encryptedRefreshToken) return false;
    this.apply(input.update);
    return true;
  }

  async release(id: string, owner: string) {
    if (this.current.id === id && this.current.refreshClaimedBy === owner) {
      this.current.refreshClaimedBy = null;
      this.current.refreshClaimedUntil = null;
    }
  }

  private apply(update: GitHubTokenUpdate) {
    this.current = { ...this.current, ...update, refreshClaimedBy: null, refreshClaimedUntil: null };
  }
}

describe("GitHub access tokens", () => {
  it("refreshes only when the token expires inside the skew window", () => {
    const now = Date.parse("2026-10-24T12:00:00.000Z");
    expect(accessTokenNeedsRefresh(null, now, 5 * 60 * 1000)).toBe(false);
    expect(accessTokenNeedsRefresh(new Date(now + 60 * 60 * 1000), now, 5 * 60 * 1000)).toBe(false);
    expect(accessTokenNeedsRefresh(new Date(now + 60_000), now, 5 * 60 * 1000)).toBe(true);
  });

  it("returns a still-valid token without calling the refresh endpoint", async () => {
    const exchange = vi.fn();
    const token = await resolveGitHubAccessToken({
      accountId: "account-1",
      claimOwner: "worker-a",
      store: new MemoryTokenStore(record({ accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000) })),
      decrypt: (value) => value.replace("enc-", ""),
      encrypt: (value) => `enc-${value}`,
      exchange,
      skewMs: 5 * 60 * 1000
    });
    expect(token).toBe("access");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("lets one caller refresh a single-use token while the other waits", async () => {
    const store = new MemoryTokenStore(record());
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const exchange = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3_600, refreshTokenExpiresIn: 7_200 };
    });
    const first = resolveGitHubAccessToken({
      accountId: "account-1",
      claimOwner: "worker-a",
      store,
      decrypt: (value) => value.replace("enc-", ""),
      encrypt: (value) => `enc-${value}`,
      exchange,
      skewMs: 5 * 60 * 1000,
      claimMs: 5_000,
      waitMs: 2_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = resolveGitHubAccessToken({
      accountId: "account-1",
      claimOwner: "worker-b",
      store,
      decrypt: (value) => value.replace("enc-", ""),
      encrypt: (value) => `enc-${value}`,
      exchange,
      skewMs: 5 * 60 * 1000,
      claimMs: 5_000,
      waitMs: 2_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(1);
    releaseFirst();
    await expect(first).resolves.toBe("new-access");
    await expect(second).resolves.toBe("new-access");
    expect(calls).toBe(1);
    expect(store.current.encryptedRefreshToken).toBe("enc-new-refresh");
    expect(store.current.refreshClaimedBy).toBeNull();
  });

  it("keeps a token stored by a peer when this refresh fails", async () => {
    const store = new MemoryTokenStore(record());
    const exchange = vi.fn(async () => {
      store.current.encryptedAccessToken = "enc-peer-access";
      store.current.encryptedRefreshToken = "enc-peer-refresh";
      store.current.accessTokenExpiresAt = new Date(Date.now() + 3_600_000);
      store.current.refreshClaimedBy = null;
      store.current.refreshClaimedUntil = null;
      throw new Error("refresh token already used");
    });
    await expect(resolveGitHubAccessToken({
      accountId: "account-1",
      claimOwner: "worker-a",
      store,
      decrypt: (value) => value.replace("enc-", ""),
      encrypt: (value) => `enc-${value}`,
      exchange,
      skewMs: 5 * 60 * 1000
    })).resolves.toBe("peer-access");
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(store.current.refreshClaimedBy).toBeNull();
  });

  it("releases the claim when refresh fails so another attempt can proceed", async () => {
    const store = new MemoryTokenStore(record());
    const exchange = vi.fn()
      .mockRejectedValueOnce(new Error("GitHub token refresh failed"))
      .mockResolvedValueOnce({ accessToken: "recovered", refreshToken: "next-refresh", expiresIn: 3_600, refreshTokenExpiresIn: null });
    await expect(resolveGitHubAccessToken({
      accountId: "account-1",
      claimOwner: "worker-a",
      store,
      decrypt: (value) => value.replace("enc-", ""),
      encrypt: (value) => `enc-${value}`,
      exchange,
      skewMs: 5 * 60 * 1000
    })).rejects.toThrow("GitHub token refresh failed");
    expect(store.current.refreshClaimedBy).toBeNull();
    await expect(resolveGitHubAccessToken({
      accountId: "account-1",
      claimOwner: "worker-a",
      store,
      decrypt: (value) => value.replace("enc-", ""),
      encrypt: (value) => `enc-${value}`,
      exchange,
      skewMs: 5 * 60 * 1000
    })).resolves.toBe("recovered");
  });

  it("refuses to refresh when no refresh token is stored", async () => {
    await expect(resolveGitHubAccessToken({
      accountId: "account-1",
      claimOwner: "worker-a",
      store: new MemoryTokenStore(record({ encryptedRefreshToken: null })),
      decrypt: (value) => value,
      encrypt: (value) => value,
      exchange: vi.fn(),
      skewMs: 5 * 60 * 1000
    })).rejects.toThrow("refresh token is unavailable");
  });

  it("posts a refresh-token grant and does not treat an error body as success", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({ access_token: "abc", refresh_token: "def", expires_in: 60 }), { status: 200 }));
    await expect(exchangeOAuthRefreshToken({
      webBaseUrl: "https://github.com",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh-me",
      fetchImpl: fetchImpl as typeof fetch
    })).resolves.toMatchObject({ accessToken: "abc", refreshToken: "def", expiresIn: 60 });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { grant_type?: string; refresh_token?: string };
    expect(body.grant_type).toBe("refresh_token");
    expect(body.refresh_token).toBe("refresh-me");

    const failing = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ error: "bad" }), { status: 400 }));
    await expect(exchangeOAuthRefreshToken({
      webBaseUrl: "https://github.com",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh-me",
      fetchImpl: failing as typeof fetch
    })).rejects.toThrow("GitHub token refresh failed");
  });
});
