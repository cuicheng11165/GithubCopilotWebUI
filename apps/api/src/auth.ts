import type { FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqualString } from "@app/security";
import { db, type ChatSession } from "@app/db";
import { decryptSecret, encryptSecret, hashToken } from "./crypto.js";
import { oauthProviders } from "./config.js";
import { readUsableGithubAccount, resolveGithubToken, type GithubRefreshResponse, type GithubTokenUpdate } from "./token-refresh.js";

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
    if (typeof csrf !== "string" || !timingSafeEqualString(csrf, webSession.csrfToken)) return reply.code(403).send({ error: "Invalid CSRF token" });
  }
  let account = webSession.githubAccount;
  let githubToken: string;
  const refreshDeps = {
    decrypt: decryptSecret,
    encrypt: encryptSecret,
    findAccount: (id: string) => db.gitHubAccount.findUnique({ where: { id } }),
    updateAccount: (id: string, data: GithubTokenUpdate) => db.gitHubAccount.update({ where: { id }, data }),
    requestRefresh: requestGithubRefresh
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
  const response = await fetch(`${provider.webBaseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "copilot-web-ui" },
    body: JSON.stringify({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });
  return await response.json() as GithubRefreshResponse;
}

export function bindSessionLog(request: FastifyRequest, userId: string, sessionId: string): void {
  request.log = request.log.child({ userId, sessionId });
  request.log.info({ method: request.method, url: request.url }, "Session request");
}

export async function ownedSession(userId: string, sessionId: string): Promise<ChatSession | null> {
  return db.chatSession.findFirst({ where: { id: sessionId, userId } });
}
