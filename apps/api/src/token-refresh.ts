import {
  accessTokenNeedsRefresh,
  resolveGitHubAccessToken,
  type GitHubAccountTokenRecord,
  type GitHubTokenStore
} from "../../../packages/db/src/github-access-token.js";

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
  tokenStore?: GitHubTokenStore;
  claimOwner?: string;
  now?: () => number;
}

export interface ResolvedGithubToken<T extends RefreshableAccount = RefreshableAccount> {
  account: T;
  githubToken: string;
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;
// Callers in this process share one refresh. The token store claim serializes the API and the worker.
const inflight = new Map<string, Promise<ResolvedGithubToken>>();

export function needsGithubTokenRefresh(account: { accessTokenExpiresAt: Date | null }, now = Date.now()): boolean {
  return accessTokenNeedsRefresh(account.accessTokenExpiresAt, now, REFRESH_SKEW_MS);
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

function toRecord(account: RefreshableAccount): GitHubAccountTokenRecord {
  const claimed = account as RefreshableAccount & Partial<Pick<GitHubAccountTokenRecord, "host" | "refreshClaimedBy" | "refreshClaimedUntil">>;
  return {
    id: account.id,
    provider: account.provider,
    host: claimed.host ?? "",
    encryptedAccessToken: account.encryptedAccessToken,
    encryptedRefreshToken: account.encryptedRefreshToken,
    accessTokenExpiresAt: account.accessTokenExpiresAt,
    refreshTokenExpiresAt: account.refreshTokenExpiresAt,
    refreshClaimedBy: claimed.refreshClaimedBy ?? null,
    refreshClaimedUntil: claimed.refreshClaimedUntil ?? null
  };
}

function depsStore<T extends RefreshableAccount>(deps: TokenRefreshDeps<T>, remember: (account: T) => void): GitHubTokenStore {
  return {
    async find(id) {
      const found = await deps.findAccount(id);
      return found ? toRecord(found) : null;
    },
    async claim() {
      return true;
    },
    async save(input) {
      remember(await deps.updateAccount(input.id, input.update));
      return true;
    },
    async saveIfRefreshTokenMatches(input) {
      remember(await deps.updateAccount(input.id, input.update));
      return true;
    },
    async release() {}
  };
}

async function refreshAccount<T extends RefreshableAccount>(stale: T, deps: TokenRefreshDeps<T>): Promise<ResolvedGithubToken<T>> {
  let persisted: T | undefined;
  const store = deps.tokenStore ?? depsStore(deps, (account) => { persisted = account; });
  try {
    const githubToken = await resolveGitHubAccessToken({
      accountId: stale.id,
      claimOwner: deps.claimOwner ?? `api:${stale.id}`,
      store,
      decrypt: deps.decrypt,
      encrypt: deps.encrypt,
      exchange: async (refreshToken, record) => {
        const refreshed = await deps.requestRefresh(record as unknown as T, refreshToken);
        if (!refreshed.access_token) throw new Error("GitHub token refresh failed");
        return {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? null,
          expiresIn: typeof refreshed.expires_in === "number" ? refreshed.expires_in : null,
          refreshTokenExpiresIn: typeof refreshed.refresh_token_expires_in === "number" ? refreshed.refresh_token_expires_in : null
        };
      },
      skewMs: REFRESH_SKEW_MS,
      now: () => clock(deps)
    });
    if (persisted) return { account: persisted, githubToken };
    const account = await deps.findAccount(stale.id);
    if (!account) throw new Error("GitHub account not found");
    return { account, githubToken };
  } catch (error) {
    const recovered = await readUsableGithubAccount(stale.id, deps.findAccount, deps.decrypt, clock(deps));
    if (recovered) return recovered;
    throw error instanceof Error ? error : new Error("GitHub token refresh failed");
  }
}
