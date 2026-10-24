export interface RefreshableAccount {
  id: string;
  provider: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

export interface GithubTokenUpdate {
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

export interface GithubRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}

export interface TokenRefreshDeps<T extends RefreshableAccount> {
  decrypt: (value: string) => string;
  encrypt: (value: string) => string;
  findAccount: (id: string) => Promise<T | null>;
  updateAccount: (id: string, data: GithubTokenUpdate) => Promise<T>;
  requestRefresh: (account: T, refreshToken: string) => Promise<GithubRefreshResponse>;
  now?: () => number;
}

export interface ResolvedGithubToken<T extends RefreshableAccount = RefreshableAccount> {
  account: T;
  githubToken: string;
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const inflight = new Map<string, Promise<ResolvedGithubToken>>();

export function needsGithubTokenRefresh(account: { accessTokenExpiresAt: Date | null }, now = Date.now()): boolean {
  return account.accessTokenExpiresAt !== null && account.accessTokenExpiresAt.getTime() <= now + REFRESH_SKEW_MS;
}

function clock<T extends RefreshableAccount>(deps: TokenRefreshDeps<T>): number {
  return deps.now?.() ?? Date.now();
}

export async function readUsableGithubAccount<T extends RefreshableAccount>(
  accountId: string,
  findAccount: TokenRefreshDeps<T>["findAccount"],
  decrypt: TokenRefreshDeps<T>["decrypt"],
  now = Date.now()
): Promise<ResolvedGithubToken<T> | null> {
  const latest = await findAccount(accountId);
  if (!latest || needsGithubTokenRefresh(latest, now)) return null;
  try {
    return { account: latest, githubToken: decrypt(latest.encryptedAccessToken) };
  } catch {
    return null;
  }
}

export async function resolveGithubToken<T extends RefreshableAccount>(account: T, deps: TokenRefreshDeps<T>): Promise<ResolvedGithubToken<T>> {
  if (!needsGithubTokenRefresh(account, clock(deps))) {
    return { account, githubToken: deps.decrypt(account.encryptedAccessToken) };
  }
  const existing = inflight.get(account.id);
  if (existing) return existing as Promise<ResolvedGithubToken<T>>;
  const promise = refreshAccount(account, deps).finally(() => {
    if (inflight.get(account.id) === promise) inflight.delete(account.id);
  });
  inflight.set(account.id, promise);
  return promise;
}

async function refreshAccount<T extends RefreshableAccount>(stale: T, deps: TokenRefreshDeps<T>): Promise<ResolvedGithubToken<T>> {
  const current = await deps.findAccount(stale.id);
  if (!current) throw new Error("GitHub account not found");
  if (!needsGithubTokenRefresh(current, clock(deps))) {
    return { account: current, githubToken: deps.decrypt(current.encryptedAccessToken) };
  }
  const encryptedRefreshToken = current.encryptedRefreshToken;
  if (!encryptedRefreshToken) throw new Error("GitHub refresh token is unavailable");
  try {
    const refreshToken = deps.decrypt(encryptedRefreshToken);
    const refreshed = await deps.requestRefresh(current, refreshToken);
    if (!refreshed.access_token) throw new Error("GitHub token refresh failed");
    const refreshedAt = clock(deps);
    const updated = await deps.updateAccount(current.id, {
      encryptedAccessToken: deps.encrypt(refreshed.access_token),
      encryptedRefreshToken: refreshed.refresh_token ? deps.encrypt(refreshed.refresh_token) : encryptedRefreshToken,
      accessTokenExpiresAt: refreshed.expires_in ? new Date(refreshedAt + refreshed.expires_in * 1000) : null,
      refreshTokenExpiresAt: refreshed.refresh_token_expires_in ? new Date(refreshedAt + refreshed.refresh_token_expires_in * 1000) : current.refreshTokenExpiresAt
    });
    return { account: updated, githubToken: refreshed.access_token };
  } catch (error) {
    const recovered = await readUsableGithubAccount(current.id, deps.findAccount, deps.decrypt, clock(deps));
    if (recovered) return recovered;
    throw error instanceof Error ? error : new Error("GitHub token refresh failed");
  }
}
