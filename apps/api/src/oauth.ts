import type { FastifyInstance } from "fastify";
import { db } from "@app/db";
import { config, oauthProviders } from "./config.js";
import { encryptSecret, hashToken, randomToken } from "./crypto.js";
import { SESSION_COOKIE } from "./auth.js";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

const OAUTH_STATE_COOKIE = "copilot_oauth_state";

async function githubJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "copilot-web-ui" } });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  return response.json() as Promise<T>;
}

export function registerOAuthRoutes(app: FastifyInstance): void {
  app.get("/api/auth/providers", async () => oauthProviders.map(({ id, label, host }) => ({ id, label, host })));

  app.get<{ Params: { provider: string } }>("/api/auth/:provider/login", async (request, reply) => {
    const provider = oauthProviders.find((item) => item.id === request.params.provider);
    if (!provider) return reply.code(404).send({ error: "Unknown provider" });
    const state = randomToken();
    await app.ephemeral.set(`oauth-state:${state}`, provider.id, 600);
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      path: "/api/auth",
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600
    });
    const callback = `${config.PUBLIC_APP_URL}/api/auth/${provider.id}/callback`;
    const url = new URL(`${provider.webBaseUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("redirect_uri", callback);
    url.searchParams.set("state", state);
    return reply.redirect(url.toString());
  });

  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>("/api/auth/:provider/callback", async (request, reply) => {
    const provider = oauthProviders.find((item) => item.id === request.params.provider);
    if (!provider || !request.query.code || !request.query.state || request.query.error) {
      return reply.redirect(`${config.PUBLIC_APP_URL}/login?error=oauth_failed`);
    }
    if (request.cookies[OAUTH_STATE_COOKIE] !== request.query.state) return reply.redirect(`${config.PUBLIC_APP_URL}/login?error=invalid_state`);
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/api/auth" });
    const stateProvider = await app.ephemeral.take(`oauth-state:${request.query.state}`);
    if (stateProvider !== provider.id) return reply.redirect(`${config.PUBLIC_APP_URL}/login?error=invalid_state`);

    const tokenResponse = await fetch(`${provider.webBaseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "copilot-web-ui" },
      body: JSON.stringify({ client_id: provider.clientId, client_secret: provider.clientSecret, code: request.query.code })
    });
    const token = await tokenResponse.json() as TokenResponse;
    if (!token.access_token) return reply.redirect(`${config.PUBLIC_APP_URL}/login?error=token_exchange_failed`);

    const profile = await githubJson<{ id: number; login: string; name: string | null; avatar_url: string | null }>(`${provider.apiBaseUrl}/user`, token.access_token);
    if (provider.allowedOrgs.length > 0 || provider.allowedEnterprises.length > 0) {
      const memberships = await Promise.all(provider.allowedOrgs.map(async (org) => {
        const response = await fetch(`${provider.apiBaseUrl}/user/memberships/orgs/${encodeURIComponent(org)}`, {
          headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "copilot-web-ui" }
        });
        if (!response.ok) return false;
        const membership = await response.json() as { state?: string };
        return membership.state === "active";
      }));
      const enterpriseMemberships = await Promise.all(provider.allowedEnterprises.map(async (enterprise) => {
        const response = await fetch(`${provider.apiBaseUrl}/enterprises/${encodeURIComponent(enterprise)}/members/${encodeURIComponent(profile.login)}`, {
          headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "copilot-web-ui" }
        });
        return response.status === 204;
      }));
      if (![...memberships, ...enterpriseMemberships].some(Boolean)) return reply.redirect(`${config.PUBLIC_APP_URL}/login?error=membership_required`);
    }

    const providerUserId = String(profile.id);
    let account = await db.gitHubAccount.findUnique({ where: { provider_providerUserId: { provider: provider.id, providerUserId } } });
    if (!account) {
      const user = await db.user.create({ data: { login: profile.login, displayName: profile.name, avatarUrl: profile.avatar_url } });
      account = await db.gitHubAccount.create({ data: {
        userId: user.id,
        provider: provider.id,
        providerUserId,
        host: provider.host,
        encryptedAccessToken: encryptSecret(token.access_token),
        encryptedRefreshToken: token.refresh_token ? encryptSecret(token.refresh_token) : null,
        accessTokenExpiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null,
        refreshTokenExpiresAt: token.refresh_token_expires_in ? new Date(Date.now() + token.refresh_token_expires_in * 1000) : null
      } });
    } else {
      await db.user.update({ where: { id: account.userId }, data: { login: profile.login, displayName: profile.name, avatarUrl: profile.avatar_url } });
      account = await db.gitHubAccount.update({ where: { id: account.id }, data: {
        encryptedAccessToken: encryptSecret(token.access_token),
        encryptedRefreshToken: token.refresh_token ? encryptSecret(token.refresh_token) : account.encryptedRefreshToken,
        accessTokenExpiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null,
        refreshTokenExpiresAt: token.refresh_token_expires_in ? new Date(Date.now() + token.refresh_token_expires_in * 1000) : account.refreshTokenExpiresAt
      } });
    }

    const rawSessionToken = randomToken();
    const csrfToken = randomToken();
    await db.webSession.create({ data: {
      userId: account.userId,
      githubAccountId: account.id,
      tokenHash: hashToken(rawSessionToken),
      csrfToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    } });
    reply.setCookie(SESSION_COOKIE, rawSessionToken, {
      path: "/",
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60
    });
    return reply.redirect(config.PUBLIC_APP_URL);
  });
}
