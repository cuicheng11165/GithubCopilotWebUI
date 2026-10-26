export const LOGIN_MESSAGES = {
  "signed-in": "Signed in. The browser session was saved.",
  "wrong-password": "Microsoft rejected the password.",
  "unknown-account": "Microsoft could not find that account.",
  "account-locked": "Microsoft locked this account.",
  "code-rejected": "Microsoft rejected the verification code.",
  timeout: "The Microsoft sign-in timed out.",
  unsupported: "This Microsoft sign-in step is not supported.",
  cancelled: "The secure form was cancelled.",
  failed: "Microsoft sign-in failed."
} as const;

export type LoginCode = keyof typeof LOGIN_MESSAGES;

export interface MicrosoftLoginResult {
  ok: boolean;
  code: LoginCode;
  message: string;
  storageStatePath?: string;
}

export const BROWSER_MISSING_MESSAGE = "The Chromium browser for Playwright is not installed.";

export const CONFIG_MESSAGES = {
  "url-missing": "A target URL is required.",
  url: "The target URL is invalid.",
  storage: "A storage-state path is required.",
  timeout: "The timeout is invalid.",
  poll: "The poll interval is invalid.",
  flag: "A Microsoft sign-in flag is invalid.",
  bin: "The secure form helper is unavailable."
} as const;

export type ConfigMessageCode = keyof typeof CONFIG_MESSAGES;

export function loginResult(code: LoginCode, storageStatePath?: string): MicrosoftLoginResult {
  const result: MicrosoftLoginResult = {
    ok: code === "signed-in",
    code,
    message: LOGIN_MESSAGES[code]
  };
  if (code === "signed-in" && storageStatePath) result.storageStatePath = storageStatePath;
  return result;
}

export function publicBrowserMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    message === BROWSER_MISSING_MESSAGE
    || message.includes("Executable doesn't exist")
    || message.includes("playwright install")
  ) {
    return BROWSER_MISSING_MESSAGE;
  }
  return LOGIN_MESSAGES.failed;
}

export function numberMatchPrompt(number: string): string {
  return `Approve sign-in request ${number} in Microsoft Authenticator, then continue.`;
}
