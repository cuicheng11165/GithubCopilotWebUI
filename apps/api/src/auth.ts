import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createPrismaGitHubTokenStore, db, type ChatSession } from "@app/db";
import { timingSafeEqualString } from "@app/security";
import { exchangeOAuthRefreshToken } from "../../../packages/db/src/github-access-token.js";
import { decryptSecret, encryptSecret, hashToken } from "./crypto.js";
import { oauthProviders } from "./config.js";
import { readUsableGithubAccount, resolveGithubToken, type GithubRefreshResponse, type GithubTokenUpdate } from "./token-refresh.js";

export const SESSION_COOKIE = "copilot_web_session";
const apiClaimOwner = `api:${randomUUID()}`;
const githubTokenStore = createPrismaGitHubTokenStore(db);

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const rawToken = request.cookies[SESSION_COOKIE];
  if (!rawToken) return reply.code(401).send({ error: "Authentication required" });
  const webSession = await db.webSession.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true, githubAccount: true }
  });
  if (!webSession || webSession.expiresAt <= new Date()) {
    if (webSession) await db.webSession.delete({ where: { id: webSession.id } });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(401).send({ error: "Authentication expired" });
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    const csrf = request.headers["x-csrf-token"];
    if (typeof csrf !== "string" || !timingSafeEqualString(csrf, webSession.csrfToken)) return reply.code(403).send({ error: "Invalid CSRF token" });
  }
  let account = webSession.githubAccount;
  let githubToken: string;
  const refreshDeps = {
    decrypt: decryptSecret,
    encrypt: encryptSecret,
    findAccount: (id: string) => db.gitHubAccount.findUnique({ where: { id } }),
    updateAccount: (id: string, data: GithubTokenUpdate) => db.gitHubAccount.update({ where: { id }, data }),
    requestRefresh: requestGithubRefresh,
    tokenStore: githubTokenStore,
    claimOwner: apiClaimOwner
  };
  try {
    const resolved = await resolveGithubToken(account, refreshDeps);
    account = resolved.account;
    githubToken = resolved.githubToken;
  } catch {
    const recovered = await readUsableGithubAccount(account.id, refreshDeps.findAccount, decryptSecret);
    if (!recovered) {
      await db.webSession.delete({ where: { id: webSession.id } });
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(401).send({ error: "GitHub authorization expired; please sign in again" });
    }
    account = recovered.account;
    githubToken = recovered.githubToken;
  }
  const validationKey = `github-token-valid:${account.id}`;
  if (!(await request.server.ephemeral.get(validationKey))) {
    const provider = oauthProviders.find((item) => item.id === account.provider);
    if (!provider) return reply.code(401).send({ error: "OAuth provider is no longer configured" });
    const response = await fetch(`${provider.apiBaseUrl}/user`, {
      headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "User-Agent": "copilot-web-ui" }
    });
    if (response.status === 401) {
      await db.webSession.deleteMany({ where: { githubAccountId: account.id } });
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(401).send({ error: "GitHub authorization was revoked; please sign in again" });
    }
    if (response.ok) await request.server.ephemeral.set(validationKey, "1", 300);
  }
  void db.webSession.update({ where: { id: webSession.id }, data: { lastSeenAt: new Date() } });
  request.log = request.log.child({ userId: webSession.user.id });
  return {
    webSession,
    user: webSession.user,
    account,
    githubToken
  };
}

async function requestGithubRefresh(account: { provider: string }, refreshToken: string): Promise<GithubRefreshResponse> {
  const provider = oauthProviders.find((item) => item.id === account.provider);
  if (!provider) throw new Error("OAuth provider is no longer configured");
  const refreshed = await exchangeOAuthRefreshToken({
    webBaseUrl: provider.webBaseUrl,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    refreshToken
  });
  return {
    access_token: refreshed.accessToken,
    ...(refreshed.refreshToken ? { refresh_token: refreshed.refreshToken } : {}),
    ...(refreshed.expiresIn !== null ? { expires_in: refreshed.expiresIn } : {}),
    ...(refreshed.refreshTokenExpiresIn !== null ? { refresh_token_expires_in: refreshed.refreshTokenExpiresIn } : {})
  };
}

export function bindSessionLog(request: FastifyRequest, userId: string, sessionId: string): void {
  request.log = request.log.child({ userId, sessionId });
  request.log.info({ method: request.method, url: request.url }, "Session request");
}

export async function ownedSession(userId: string, sessionId: string): Promise<ChatSession | null> {
  return db.chatSession.findFirst({ where: { id: sessionId, userId } });
}
