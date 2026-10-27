import { loginResult, numberMatchPrompt, type LoginCode, type MicrosoftLoginResult } from "./messages.js";
import { firstMatch, matchNumber, selectors } from "./selectors.js";
import { SecureFormStepError } from "./secure-form-client.js";
import type { LoginPage, StepClient } from "./types.js";

const MAX_LOGIN_STEPS = 12;
const LOGIN_HOST = "login.microsoftonline.com";

type Screen =
  | { kind: "locked" | "unknown-account" | "wrong-password" | "code-rejected" | "unsupported" | "otp" | "password" | "email" | "stay-signed-in" | "success" | "pending" }
  | { kind: "number-match"; number: string };

async function detect(page: LoginPage, targetHost: string): Promise<Screen> {
  if (await firstMatch(page, selectors.locked)) return { kind: "locked" };
  if (await firstMatch(page, selectors.usernameError)) return { kind: "unknown-account" };
  if (await firstMatch(page, selectors.passwordError)) return { kind: "wrong-password" };
  if (await firstMatch(page, selectors.otpError)) return { kind: "code-rejected" };
  if (await firstMatch(page, selectors.unsupported)) return { kind: "unsupported" };
  const numberSelector = await firstMatch(page, selectors.numberMatch);
  if (numberSelector) {
    const number = matchNumber((await page.text(numberSelector)) ?? "");
    if (!number) return { kind: "unsupported" };
    return { kind: "number-match", number };
  }
  if (await firstMatch(page, selectors.otp)) return { kind: "otp" };
  if (await firstMatch(page, selectors.password)) return { kind: "password" };
  if (await firstMatch(page, selectors.email)) return { kind: "email" };
  if (await firstMatch(page, selectors.staySignedIn)) return { kind: "stay-signed-in" };
  let host = "";
  try {
    host = new URL(await page.location()).host;
  } catch {
    host = "";
  }
  if (host && host === targetHost && host !== LOGIN_HOST) return { kind: "success" };
  return { kind: "pending" };
}

function failureFrom(error: unknown): MicrosoftLoginResult {
  if (error instanceof SecureFormStepError && error.code === "cancelled") return loginResult("cancelled");
  return loginResult("failed");
}

const FIELD_BY_SCREEN = {
  email: { id: "email", label: "Work email", type: "email" as const, selectors: selectors.email },
  password: { id: "password", label: "Password", type: "password" as const, selectors: selectors.password },
  otp: { id: "code", label: "Verification code", type: "otp" as const, selectors: selectors.otp }
};

const TERMINAL: Record<string, LoginCode | undefined> = {
  locked: "account-locked",
  "unknown-account": "unknown-account",
  "wrong-password": "wrong-password",
  "code-rejected": "code-rejected",
  unsupported: "unsupported"
};

export async function runMicrosoftLogin(input: {
  page: LoginPage;
  secrets: StepClient;
  targetUrl: string;
  storageStatePath: string;
  timeoutMs: number;
  pollMs: number;
  staySignedIn: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<MicrosoftLoginResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + input.timeoutMs;
  try {
    const targetHost = new URL(input.targetUrl).host;
    await input.page.goto(input.targetUrl);
    let steps = 0;
    while (now() < deadline && steps < MAX_LOGIN_STEPS) {
      const screen = await detect(input.page, targetHost);
      const terminal = TERMINAL[screen.kind];
      if (terminal) return loginResult(terminal);
      if (screen.kind === "success") {
        await input.page.saveStorage(input.storageStatePath);
        return loginResult("signed-in", input.storageStatePath);
      }
      if (screen.kind === "number-match") {
        await input.secrets.confirm({ id: "approve", prompt: numberMatchPrompt(screen.number) });
        steps += 1;
        while (now() < deadline) {
          const next = await detect(input.page, targetHost);
          if (next.kind !== "number-match") break;
          await sleep(input.pollMs);
        }
        continue;
      }
      if (screen.kind === "email" || screen.kind === "password" || screen.kind === "otp") {
        const field = FIELD_BY_SCREEN[screen.kind];
        const selector = await firstMatch(input.page, field.selectors);
        const submit = await firstMatch(input.page, selectors.submit);
        if (!selector || !submit) return loginResult("failed");
        const value = await input.secrets.input({ id: field.id, label: field.label, type: field.type });
        await input.page.fill(selector, value);
        await input.page.click(submit);
        steps += 1;
        continue;
      }
      if (screen.kind === "stay-signed-in") {
        const button = await firstMatch(input.page, input.staySignedIn ? selectors.submit : selectors.back);
        if (!button) return loginResult("failed");
        await input.page.click(button);
        steps += 1;
        continue;
      }
      await sleep(input.pollMs);
    }
    return loginResult("timeout");
  } catch (error) {
    return failureFrom(error);
  }
}
