import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "@app/db";
import { decryptSecret, encryptSecret, hashToken } from "./crypto.js";
import { oauthProviders } from "./config.js";

export const SESSION_COOKIE = "copilot_web_session";

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
    if (csrf !== webSession.csrfToken) return reply.code(403).send({ error: "Invalid CSRF token" });
  }
  let account = webSession.githubAccount;
  let githubToken: string;
  try {
    const needsRefresh = account.accessTokenExpiresAt !== null && account.accessTokenExpiresAt.getTime() <= Date.now() + 5 * 60 * 1000;
    if (needsRefresh) {
      if (!account.encryptedRefreshToken) throw new Error("GitHub refresh token is unavailable");
      const provider = oauthProviders.find((item) => item.id === account.provider);
      if (!provider) throw new Error("OAuth provider is no longer configured");
      const response = await fetch(`${provider.webBaseUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "copilot-web-ui" },
        body: JSON.stringify({
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          grant_type: "refresh_token",
          refresh_token: decryptSecret(account.encryptedRefreshToken)
        })
      });
      const refreshed = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number };
      if (!refreshed.access_token) throw new Error("GitHub token refresh failed");
      account = await db.gitHubAccount.update({ where: { id: account.id }, data: {
        encryptedAccessToken: encryptSecret(refreshed.access_token),
        encryptedRefreshToken: refreshed.refresh_token ? encryptSecret(refreshed.refresh_token) : account.encryptedRefreshToken,
        accessTokenExpiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000) : null,
        refreshTokenExpiresAt: refreshed.refresh_token_expires_in ? new Date(Date.now() + refreshed.refresh_token_expires_in * 1000) : account.refreshTokenExpiresAt
      } });
      githubToken = refreshed.access_token;
    } else githubToken = decryptSecret(account.encryptedAccessToken);
  } catch {
    await db.webSession.delete({ where: { id: webSession.id } });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(401).send({ error: "GitHub authorization expired; please sign in again" });
  }
  const validationKey = `github-token-valid:${account.id}`;
  if (!(await request.server.redis.get(validationKey))) {
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
    if (response.ok) await request.server.redis.set(validationKey, "1", "EX", 300);
  }
  void db.webSession.update({ where: { id: webSession.id }, data: { lastSeenAt: new Date() } });
  return {
    webSession,
    user: webSession.user,
    account,
    githubToken
  };
}

export async function ownedSession(userId: string, sessionId: string) {
  return db.chatSession.findFirst({ where: { id: sessionId, userId } });
}
