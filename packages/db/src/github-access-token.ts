export interface GitHubAccountTokenRecord {
  id: string;
  provider: string;
  host: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  refreshClaimedBy: string | null;
  refreshClaimedUntil: Date | null;
}

export interface GitHubTokenUpdate {
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

export interface GitHubTokenStore {
  find(id: string): Promise<GitHubAccountTokenRecord | null>;
  claim(input: { id: string; encryptedRefreshToken: string; owner: string; until: Date; now: Date }): Promise<boolean>;
  save(input: { id: string; owner: string; update: GitHubTokenUpdate }): Promise<boolean>;
  saveIfRefreshTokenMatches(input: { id: string; encryptedRefreshToken: string; update: GitHubTokenUpdate }): Promise<boolean>;
  release(id: string, owner: string): Promise<void>;
}

export interface OAuthRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  refreshTokenExpiresIn: number | null;
}

export function accessTokenNeedsRefresh(expiresAt: Date | null, now: number, skewMs: number): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now + skewMs;
}

export async function exchangeOAuthRefreshToken(input: {
  webBaseUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<OAuthRefreshResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${input.webBaseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "copilot-web-ui" },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000)
  });
  const refreshed = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number };
  if (!response.ok || !refreshed.access_token) throw new Error("GitHub token refresh failed");
  return {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? null,
    expiresIn: typeof refreshed.expires_in === "number" ? refreshed.expires_in : null,
    refreshTokenExpiresIn: typeof refreshed.refresh_token_expires_in === "number" ? refreshed.refresh_token_expires_in : null
  };
}

async function waitForPeerRefresh(input: {
  account: GitHubAccountTokenRecord;
  store: GitHubTokenStore;
  decrypt: (value: string) => string;
  skewMs: number;
  waitMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<string | null> {
  const deadline = input.now() + input.waitMs;
  while (input.now() < deadline) {
    await input.sleep(50);
    const latest = await input.store.find(input.account.id);
    if (!latest) throw new Error("GitHub account not found");
    if (!accessTokenNeedsRefresh(latest.accessTokenExpiresAt, input.now(), input.skewMs)) return input.decrypt(latest.encryptedAccessToken);
    const claimHeld = latest.refreshClaimedUntil !== null && latest.refreshClaimedUntil.getTime() > input.now();
    if (!claimHeld) return null;
  }
  throw new Error("Timed out waiting for GitHub token refresh");
}

export async function resolveGitHubAccessToken(input: {
  accountId: string;
  claimOwner: string;
  store: GitHubTokenStore;
  decrypt: (value: string) => string;
  encrypt: (value: string) => string;
  exchange: (refreshToken: string, account: GitHubAccountTokenRecord) => Promise<OAuthRefreshResult>;
  skewMs?: number;
  claimMs?: number;
  waitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const skewMs = input.skewMs ?? 5 * 60 * 1000;
  const claimMs = input.claimMs ?? 60_000;
  const waitMs = input.waitMs ?? 70_000;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const account = await input.store.find(input.accountId);
    if (!account) throw new Error("GitHub account not found");
    if (!accessTokenNeedsRefresh(account.accessTokenExpiresAt, now(), skewMs)) return input.decrypt(account.encryptedAccessToken);
    if (!account.encryptedRefreshToken) throw new Error("GitHub refresh token is unavailable");
    const claimed = await input.store.claim({
      id: account.id,
      encryptedRefreshToken: account.encryptedRefreshToken,
      owner: input.claimOwner,
      until: new Date(now() + claimMs),
      now: new Date(now())
    });
    if (!claimed) {
      const waited = await waitForPeerRefresh({ account, store: input.store, decrypt: input.decrypt, skewMs, waitMs, now, sleep });
      if (waited) return waited;
      continue;
    }
    try {
      const exchanged = await input.exchange(input.decrypt(account.encryptedRefreshToken), account);
      const update: GitHubTokenUpdate = {
        encryptedAccessToken: input.encrypt(exchanged.accessToken),
        encryptedRefreshToken: exchanged.refreshToken ? input.encrypt(exchanged.refreshToken) : account.encryptedRefreshToken,
        accessTokenExpiresAt: exchanged.expiresIn ? new Date(now() + exchanged.expiresIn * 1000) : null,
        refreshTokenExpiresAt: exchanged.refreshTokenExpiresIn ? new Date(now() + exchanged.refreshTokenExpiresIn * 1000) : account.refreshTokenExpiresAt
      };
      if (await input.store.save({ id: account.id, owner: input.claimOwner, update })) return exchanged.accessToken;
      const latest = await input.store.find(account.id);
      if (latest && !accessTokenNeedsRefresh(latest.accessTokenExpiresAt, now(), skewMs)) return input.decrypt(latest.encryptedAccessToken);
      if (await input.store.saveIfRefreshTokenMatches({ id: account.id, encryptedRefreshToken: account.encryptedRefreshToken, update })) return exchanged.accessToken;
      const after = await input.store.find(account.id);
      if (after && !accessTokenNeedsRefresh(after.accessTokenExpiresAt, now(), skewMs)) return input.decrypt(after.encryptedAccessToken);
      throw new Error("GitHub token refresh could not be stored");
    } catch (error) {
      try {
        await input.store.release(account.id, input.claimOwner);
      } catch {
        // Callers handle the refresh error below.
      }
      try {
        const latest = await input.store.find(account.id);
        if (latest && !accessTokenNeedsRefresh(latest.accessTokenExpiresAt, now(), skewMs)) return input.decrypt(latest.encryptedAccessToken);
      } catch {
        // A peer may have stored a usable token. If that read fails, keep the original error.
      }
      throw error;
    }
  }
  throw new Error("Timed out waiting for GitHub token refresh");
}
