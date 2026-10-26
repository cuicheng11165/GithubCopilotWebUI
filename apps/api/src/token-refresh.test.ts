import { describe, expect, it, vi } from "vitest";
import {
  needsGithubTokenRefresh,
  readUsableGithubAccount,
  resolveGithubToken,
  type GithubTokenUpdate,
  type RefreshableAccount,
  type TokenRefreshDeps
} from "./token-refresh.js";

const NOW = 1_700_000_000_000;

function account(overrides: Partial<RefreshableAccount> = {}): RefreshableAccount {
  return {
    id: "account-1",
    provider: "github",
    encryptedAccessToken: "old-access",
    encryptedRefreshToken: "old-refresh",
    accessTokenExpiresAt: new Date(NOW - 60_000),
    refreshTokenExpiresAt: new Date(NOW + 86_400_000),
    ...overrides
  };
}

function deps(overrides: Partial<TokenRefreshDeps<RefreshableAccount>> = {}): TokenRefreshDeps<RefreshableAccount> {
  return {
    decrypt: (value: string) => value,
    encrypt: (value: string) => `enc:${value}`,
    findAccount: async (id: string) => account({ id }),
    updateAccount: async (id: string, data: GithubTokenUpdate) => account({ id, ...data }),
    requestRefresh: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
    now: () => NOW,
    ...overrides
  };
}

describe("GitHub token refresh", () => {
  it("refreshes inside the five-minute skew window and keeps a later token", () => {
    expect(needsGithubTokenRefresh(account({ accessTokenExpiresAt: new Date(NOW + 5 * 60 * 1000) }), NOW)).toBe(true);
    expect(needsGithubTokenRefresh(account({ accessTokenExpiresAt: new Date(NOW + 5 * 60 * 1000 + 1) }), NOW)).toBe(false);
    expect(needsGithubTokenRefresh(account({ accessTokenExpiresAt: null }), NOW)).toBe(false);
  });

  it("decrypts a current access token without contacting GitHub", async () => {
    const current = account({ encryptedAccessToken: "current-access", accessTokenExpiresAt: new Date(NOW + 3_600_000) });
    const findAccount = vi.fn();
    const requestRefresh = vi.fn();
    const resolved = await resolveGithubToken(current, deps({ findAccount, requestRefresh }));
    expect(resolved.githubToken).toBe("current-access");
    expect(findAccount).not.toHaveBeenCalled();
    expect(requestRefresh).not.toHaveBeenCalled();
  });

  it("shares one refresh for concurrent callers of the same account", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requestRefresh = vi.fn(async () => {
      await gate;
      return { access_token: "shared-access", refresh_token: "shared-refresh", expires_in: 3600 };
    });
    const updateAccount = vi.fn(async (id: string, data: GithubTokenUpdate) => account({ id, ...data }));
    const refreshDeps = deps({ requestRefresh, updateAccount });
    const first = resolveGithubToken(account(), refreshDeps);
    const second = resolveGithubToken(account(), refreshDeps);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(updateAccount).toHaveBeenCalledTimes(1);
    expect(left.githubToken).toBe("shared-access");
    expect(right.githubToken).toBe("shared-access");
    expect(left.account.encryptedAccessToken).toBe("enc:shared-access");
  });

  it("refreshes different accounts independently", async () => {
    const requestRefresh = vi.fn(async (current: RefreshableAccount) => ({ access_token: `token-${current.id}`, expires_in: 3600 }));
    await Promise.all([
      resolveGithubToken(account({ id: "account-a" }), deps({ requestRefresh })),
      resolveGithubToken(account({ id: "account-b" }), deps({ requestRefresh }))
    ]);
    expect(requestRefresh).toHaveBeenCalledTimes(2);
  });

  it("skips GitHub when the database already has a usable token", async () => {
    const requestRefresh = vi.fn();
    const fresh = account({ encryptedAccessToken: "db-access", accessTokenExpiresAt: new Date(NOW + 3_600_000) });
    const resolved = await resolveGithubToken(account(), deps({
      requestRefresh,
      findAccount: async () => fresh
    }));
    expect(requestRefresh).not.toHaveBeenCalled();
    expect(resolved.githubToken).toBe("db-access");
  });

  it("re-reads the account after a failed refresh and keeps the rotated token", async () => {
    const fresh = account({ encryptedAccessToken: "rotated-access", accessTokenExpiresAt: new Date(NOW + 3_600_000) });
    let reads = 0;
    const requestRefresh = vi.fn(async () => { throw new Error("refresh token already used"); });
    const resolved = await resolveGithubToken(account(), deps({
      requestRefresh,
      findAccount: async () => {
        reads += 1;
        return reads === 1 ? account() : fresh;
      }
    }));
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(resolved.githubToken).toBe("rotated-access");
    expect(resolved.account).toBe(fresh);
  });

  it("still fails when the re-read account remains expired", async () => {
    const requestRefresh = vi.fn(async () => { throw new Error("refresh token already used"); });
    await expect(resolveGithubToken(account(), deps({
      requestRefresh,
      findAccount: async () => account()
    }))).rejects.toThrow(/refresh token already used/);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
  });

  it("fails when GitHub returns no access token", async () => {
    await expect(resolveGithubToken(account(), deps({
      requestRefresh: async () => ({})
    }))).rejects.toThrow(/GitHub token refresh failed/);
  });

  it("claims through the shared token store before calling GitHub", async () => {
    let claims = 0;
    const requestRefresh = vi.fn(async () => ({ access_token: "claimed-access", refresh_token: "next-refresh", expires_in: 3600 }));
    const updateAccount = vi.fn();
    const current = account();
    const resolved = await resolveGithubToken(current, deps({
      requestRefresh,
      updateAccount,
      tokenStore: {
        find: async () => ({
          ...current,
          host: "github.com",
          refreshClaimedBy: null,
          refreshClaimedUntil: null
        }),
        claim: async () => {
          claims += 1;
          return true;
        },
        save: async () => true,
        saveIfRefreshTokenMatches: async () => true,
        release: async () => {}
      }
    }));
    expect(claims).toBe(1);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(updateAccount).not.toHaveBeenCalled();
    expect(resolved.githubToken).toBe("claimed-access");
  });

  it("reads a usable account and ignores an expired or undecryptable one", async () => {
    const fresh = account({ encryptedAccessToken: "plain-access", accessTokenExpiresAt: new Date(NOW + 3_600_000) });
    await expect(readUsableGithubAccount("account-1", async () => fresh, (value) => value, NOW)).resolves.toMatchObject({ githubToken: "plain-access" });
    await expect(readUsableGithubAccount("account-1", async () => account(), (value) => value, NOW)).resolves.toBeNull();
    await expect(readUsableGithubAccount("account-1", async () => fresh, () => { throw new Error("bad ciphertext"); }, NOW)).resolves.toBeNull();
  });
});
