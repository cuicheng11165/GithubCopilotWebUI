import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseLoginConfig } from "./config.js";
import { createFixturePage, fixtureSentinels, loadFixtureHtml, selectorMatches } from "./fixture-page.js";
import { runMicrosoftLogin } from "./flow.js";
import { BROWSER_MISSING_MESSAGE, LOGIN_MESSAGES, numberMatchPrompt, publicBrowserMessage } from "./messages.js";
import { firstMatch, matchNumber, selectors } from "./selectors.js";
import { SecureFormStepError } from "./secure-form-client.js";
import type { LoginPage, StepClient } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    }
  };
}

function scripted(values: readonly (string | "confirm" | "cancel")[]): StepClient & { prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  const take = (prompt: string) => {
    prompts.push(prompt);
    const next = values[index];
    index += 1;
    if (next === undefined || next === "cancel") throw new SecureFormStepError("cancelled");
    return next;
  };
  return {
    prompts,
    async input(request) {
      const value = take(request.label);
      if (value === "confirm") throw new SecureFormStepError("failed");
      return value;
    },
    async confirm(request) {
      const value = take(request.prompt);
      if (value !== "confirm") throw new SecureFormStepError("failed");
    }
  };
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ms-login-flow-"));
  directories.push(directory);
  return directory;
}

describe("Microsoft login flow", () => {
  it("includes every login selector in the local fixture", async () => {
    const html = await loadFixtureHtml();
    for (const id of ["i0116", "i0118", "idSIButton9", "idBtn_Back", "usernameError", "passwordError", "idTxtBx_SAOTCC_OTC", "idSpan_SAOTCC_Error_OTC", "idRichContext_DisplaySign", "idA_IL_Locked", "KmsiDescription", "idUnsupported", "idDiv_SAOTCS_Proofs", "idDiv_SAASDS_Title"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(selectorMatches(html, "input[name=loginfmt]")).toBe(true);
    expect(selectorMatches(html, "input[name=passwd]")).toBe(true);
    expect(selectorMatches(html, "input[name=otc]")).toBe(true);
    expect(matchNumber("42")).toBe("42");
    expect(matchNumber("number 7")).toBe("7");
    expect(matchNumber("12 99")).toBeNull();
    expect(matchNumber("1234")).toBeNull();
  });

  it("uses the email name selector when the id is hidden", async () => {
    expect(await firstMatch({
      async visible(selector: string) {
        return selector === "input[name=loginfmt]";
      }
    }, selectors.email)).toBe("input[name=loginfmt]");
    const directory = await tempDir();
    const storage = path.join(directory, "nested", "state.json");
    const page = await createFixturePage({ scenario: "none", emailByName: true });
    const secrets = scripted(["ada@contoso.com", "correct-horse-battery"]);
    const result = await runMicrosoftLogin({
      page,
      secrets,
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: storage,
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result.code).toBe("signed-in");
    expect(page.filledSelectors()).toContain("input[name=loginfmt]");
  });

  it("walks email, password, verification code, and stay signed in", async () => {
    const directory = await tempDir();
    const storage = path.join(directory, "nested", "state.json");
    const page = await createFixturePage({ scenario: "otp" });
    const secrets = scripted(["ada@contoso.com", "correct-horse-battery", "123456"]);
    const result = await runMicrosoftLogin({
      page,
      secrets,
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: storage,
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result).toMatchObject({ ok: true, code: "signed-in", message: LOGIN_MESSAGES["signed-in"], storageStatePath: storage });
    const body = JSON.stringify(result);
    expect(body).not.toContain("ada@contoso.com");
    expect(body).not.toContain("correct-horse-battery");
    expect(body).not.toContain("123456");
    const saved = await readFile(storage, "utf8");
    expect(saved).not.toContain("correct-horse-battery");
    expect(saved).not.toContain("123456");
    expect(saved).not.toContain("ada@contoso.com");
    expect((await stat(storage)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(storage))).mode & 0o777).toBe(0o700);
    expect(page.clicks().at(-1)).toEqual({ screen: "stay-signed-in", selector: "#idSIButton9" });
  });

  it("shows the authenticator number and continues after approval", async () => {
    const directory = await tempDir();
    const storage = path.join(directory, "state.json");
    const page = await createFixturePage({ scenario: "number" });
    const secrets = scripted(["ada@contoso.com", "correct-horse-battery", "confirm"]);
    const original = secrets.confirm.bind(secrets);
    secrets.confirm = async (request) => {
      page.releaseNumberMatch();
      await original(request);
    };
    const result = await runMicrosoftLogin({
      page,
      secrets,
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: storage,
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: false,
      ...clock()
    });
    expect(result.code).toBe("signed-in");
    expect(secrets.prompts).toContain(numberMatchPrompt("42"));
    expect(JSON.stringify(result)).not.toContain("42");
    expect(JSON.stringify(result)).not.toContain("correct-horse-battery");
    expect(page.clicks().at(-1)).toEqual({ screen: "stay-signed-in", selector: "#idBtn_Back" });
  });

  it("signs in without an MFA step", async () => {
    const directory = await tempDir();
    const page = await createFixturePage({ scenario: "none" });
    const secrets = scripted(["ada@contoso.com", "correct-horse-battery"]);
    const result = await runMicrosoftLogin({
      page,
      secrets,
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: path.join(directory, "state.json"),
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result.ok).toBe(true);
    expect(secrets.prompts).toEqual(["Work email", "Password"]);
  });

  it("reports an unknown account without echoing the email", async () => {
    const page = await createFixturePage({ scenario: "none" });
    const secrets = scripted([fixtureSentinels.unknownEmail]);
    const result = await runMicrosoftLogin({
      page,
      secrets,
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: "/tmp/unused-ms-login.json",
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result).toMatchObject({ ok: false, code: "unknown-account", message: LOGIN_MESSAGES["unknown-account"] });
    expect(JSON.stringify(result)).not.toContain(fixtureSentinels.unknownEmail);
    expect(result.storageStatePath).toBeUndefined();
  });

  it("reports a locked account", async () => {
    const page = await createFixturePage({ scenario: "none" });
    const result = await runMicrosoftLogin({
      page,
      secrets: scripted([fixtureSentinels.lockedEmail]),
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: "/tmp/unused-ms-login.json",
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result.code).toBe("account-locked");
    expect(JSON.stringify(result)).not.toContain(fixtureSentinels.lockedEmail);
  });

  it("does not return a fill error that echoes the password", async () => {
    const page = await createFixturePage({ scenario: "none" });
    const original = page.fill.bind(page);
    page.fill = async (selector, value) => {
      if (selector === "#i0118" || selector === "input[name=passwd]") throw new Error(`could not type ${value}`);
      await original(selector, value);
    };
    const result = await runMicrosoftLogin({
      page,
      secrets: scripted(["ada@contoso.com", "correct-horse-battery"]),
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: "/tmp/unused-ms-login.json",
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result).toMatchObject({ code: "failed", message: LOGIN_MESSAGES.failed });
    expect(JSON.stringify(result)).not.toContain("correct-horse-battery");
    expect(JSON.stringify(result)).not.toContain("could not type");
  });

  it("reports a rejected password without echoing it", async () => {
    const page = await createFixturePage({ scenario: "otp" });
    const result = await runMicrosoftLogin({
      page,
      secrets: scripted(["ada@contoso.com", fixtureSentinels.wrongPassword]),
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: "/tmp/unused-ms-login.json",
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result).toMatchObject({ code: "wrong-password", message: LOGIN_MESSAGES["wrong-password"] });
    expect(JSON.stringify(result)).not.toContain(fixtureSentinels.wrongPassword);
    expect(JSON.stringify(result)).not.toContain("ada@contoso.com");
  });

  it("reports a rejected verification code without echoing it", async () => {
    const page = await createFixturePage({ scenario: "otp" });
    const result = await runMicrosoftLogin({
      page,
      secrets: scripted(["ada@contoso.com", "correct-horse-battery", fixtureSentinels.rejectedCode]),
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: "/tmp/unused-ms-login.json",
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result.code).toBe("code-rejected");
    expect(JSON.stringify(result)).not.toContain(fixtureSentinels.rejectedCode);
    expect(JSON.stringify(result)).not.toContain("correct-horse-battery");
  });

  it("stops on a security-key or captcha screen", async () => {
    const page = await createFixturePage({ scenario: "unsupported" });
    const secrets = scripted(["ada@contoso.com", "correct-horse-battery"]);
    const result = await runMicrosoftLogin({
      page,
      secrets,
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: "/tmp/unused-ms-login.json",
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result.code).toBe("unsupported");
    expect(secrets.prompts).toEqual(["Work email", "Password"]);
  });

  it("times out when number matching never completes", async () => {
    const page = await createFixturePage({ scenario: "number" });
    const result = await runMicrosoftLogin({
      page,
      secrets: scripted(["ada@contoso.com", "correct-horse-battery", "confirm"]),
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: "/tmp/unused-ms-login.json",
      timeoutMs: 50,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result.code).toBe("timeout");
    expect(JSON.stringify(result)).not.toContain("42");
  });

  it("returns when the secure form is cancelled", async () => {
    const page = await createFixturePage({ scenario: "none" });
    const result = await runMicrosoftLogin({
      page,
      secrets: scripted(["ada@contoso.com", "cancel"]),
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: "/tmp/unused-ms-login.json",
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result.code).toBe("cancelled");
    expect(JSON.stringify(result)).not.toContain("ada@contoso.com");
  });

  it("times out when the page never shows a login step", async () => {
    const page: LoginPage = {
      async goto() { return undefined; },
      async visible() { return false; },
      async text() { return null; },
      async fill() { return undefined; },
      async click() { return undefined; },
      async location() { return "https://login.microsoftonline.com/"; },
      async saveStorage() { return undefined; }
    };
    const result = await runMicrosoftLogin({
      page,
      secrets: scripted([]),
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: "/tmp/unused-ms-login.json",
      timeoutMs: 30,
      pollMs: 10,
      staySignedIn: true,
      ...clock()
    });
    expect(result.code).toBe("timeout");
  });

  it("rejects an ambiguous number without asking the user to continue", async () => {
    const page: LoginPage = {
      async goto() { return undefined; },
      async visible(selector: string) { return selector === "#idRichContext_DisplaySign"; },
      async text() { return "12 99"; },
      async fill() { return undefined; },
      async click() { return undefined; },
      async location() { return "https://login.microsoftonline.com/"; },
      async saveStorage() { return undefined; }
    };
    let confirmed = false;
    const result = await runMicrosoftLogin({
      page,
      secrets: {
        async input() { return ""; },
        async confirm() { confirmed = true; }
      },
      targetUrl: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: "/tmp/unused-ms-login.json",
      timeoutMs: 5_000,
      pollMs: 20,
      staySignedIn: true,
      ...clock()
    });
    expect(result.code).toBe("unsupported");
    expect(confirmed).toBe(false);
  });
});

describe("login configuration", () => {
  it("reads arguments and environment defaults", () => {
    expect(parseLoginConfig(["--url", "https://contoso.sharepoint.com/sites/guild", "--storage", "./state.json"], {})).toMatchObject({
      url: "https://contoso.sharepoint.com/sites/guild",
      storageStatePath: "./state.json",
      headless: true,
      timeoutMs: 180_000,
      pollMs: 2_000,
      staySignedIn: true,
      chromiumNoSandbox: false
    });
    expect(parseLoginConfig([], {
      MS_LOGIN_URL: "https://contoso.sharepoint.com",
      MS_LOGIN_STORAGE: "/tmp/session.json",
      MS_LOGIN_HEADLESS: "false",
      MS_LOGIN_TIMEOUT_MS: "9000",
      MS_LOGIN_POLL_MS: "100",
      MS_LOGIN_STAY_SIGNED_IN: "0",
      MS_LOGIN_CHROMIUM_NO_SANDBOX: "1"
    })).toMatchObject({
      headless: false,
      timeoutMs: 9000,
      pollMs: 100,
      staySignedIn: false,
      chromiumNoSandbox: true
    });
  });

  it("replaces a browser launch error with a fixed message", () => {
    const secret = "hunter2-not-a-path";
    expect(publicBrowserMessage(new Error(`Executable doesn't exist at /tmp/${secret}`))).toBe(BROWSER_MISSING_MESSAGE);
    expect(publicBrowserMessage(new Error(`Executable doesn't exist at /tmp/${secret}`))).not.toContain(secret);
    expect(publicBrowserMessage(new Error("navigation failed"))).toBe(LOGIN_MESSAGES.failed);
  });
});
