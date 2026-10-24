import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  webSessionFindUnique: vi.fn(),
  webSessionDelete: vi.fn(),
  webSessionUpdate: vi.fn(),
  gitHubAccountFindUnique: vi.fn(),
  gitHubAccountUpdate: vi.fn()
}));

vi.mock("@app/db", () => ({
  db: {
    webSession: {
      findUnique: mocks.webSessionFindUnique,
      delete: mocks.webSessionDelete,
      update: mocks.webSessionUpdate
    },
    gitHubAccount: {
      findUnique: mocks.gitHubAccountFindUnique,
      update: mocks.gitHubAccountUpdate
    }
  }
}));

process.env.DATABASE_URL = "file:./data/auth-unit.db";
process.env.COOKIE_SECRET = randomBytes(48).toString("base64");
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.WORKER_CONTROL_TOKEN = randomBytes(48).toString("base64");
process.env.GITHUB_CLIENT_ID = "";
process.env.GITHUB_CLIENT_SECRET = "";
process.env.GHE_HOST = "";
process.env.GHE_CLIENT_ID = "";
process.env.GHE_CLIENT_SECRET = "";

let authenticate: typeof import("./auth.js").authenticate;
let encryptSecret: typeof import("./crypto.js").encryptSecret;

beforeAll(async () => {
  ({ encryptSecret } = await import("./crypto.js"));
  ({ authenticate } = await import("./auth.js"));
});

function githubAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "account-1",
    userId: "user-1",
    provider: "github",
    providerUserId: "1",
    host: "github.com",
    encryptedAccessToken: "stale-access",
    encryptedRefreshToken: "stale-refresh",
    accessTokenExpiresAt: new Date(0),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function webSession(account = githubAccount()) {
  return {
    id: "web-1",
    expiresAt: new Date(Date.now() + 86_400_000),
    csrfToken: "csrf-token",
    user: { id: "user-1", login: "octocat" },
    githubAccount: account
  };
}

function request() {
  const log = { child: vi.fn() };
  log.child.mockReturnValue(log);
  return {
    cookies: { copilot_web_session: "raw-session" },
    method: "GET",
    headers: {},
    server: { ephemeral: { get: vi.fn(async () => "1"), set: vi.fn() } },
    log
  };
}

function reply() {
  const result = { code: vi.fn(), send: vi.fn(), clearCookie: vi.fn() };
  result.code.mockReturnValue(result);
  result.send.mockReturnValue(result);
  return result;
}

beforeEach(() => {
  mocks.webSessionFindUnique.mockReset();
  mocks.webSessionDelete.mockReset();
  mocks.webSessionUpdate.mockReset();
  mocks.gitHubAccountFindUnique.mockReset();
  mocks.gitHubAccountUpdate.mockReset();
  mocks.webSessionDelete.mockResolvedValue({});
  mocks.webSessionUpdate.mockResolvedValue({});
});

describe("authenticate token refresh failure", () => {
  it("keeps the web session when a re-read finds a usable token", async () => {
    const fresh = githubAccount({
      encryptedAccessToken: encryptSecret("fresh-access"),
      accessTokenExpiresAt: new Date(Date.now() + 86_400_000)
    });
    mocks.webSessionFindUnique.mockResolvedValue(webSession());
    let reads = 0;
    mocks.gitHubAccountFindUnique.mockImplementation(async () => {
      reads += 1;
      return reads < 3 ? githubAccount() : fresh;
    });
    const response = reply();
    const result = await authenticate(request() as never, response as never);
    expect(result).toMatchObject({ githubToken: "fresh-access", user: { login: "octocat" } });
    expect(mocks.webSessionDelete).not.toHaveBeenCalled();
    expect(response.clearCookie).not.toHaveBeenCalled();
  });

  it("deletes the web session only after the re-read is still unusable", async () => {
    mocks.webSessionFindUnique.mockResolvedValue(webSession());
    mocks.gitHubAccountFindUnique.mockImplementation(async () => githubAccount());
    const response = reply();
    await authenticate(request() as never, response as never);
    expect(mocks.webSessionDelete).toHaveBeenCalledWith({ where: { id: "web-1" } });
    expect(response.code).toHaveBeenCalledWith(401);
    expect(response.clearCookie).toHaveBeenCalled();
  });
});
