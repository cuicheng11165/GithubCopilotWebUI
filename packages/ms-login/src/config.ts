export class LoginConfigError extends Error {
  constructor(readonly code: "url-missing" | "url" | "storage" | "timeout" | "poll" | "flag") {
    super(code);
    this.name = "LoginConfigError";
  }
}

export interface LoginConfig {
  url: string;
  storageStatePath: string;
  headless: boolean;
  timeoutMs: number;
  pollMs: number;
  staySignedIn: boolean;
  chromiumNoSandbox: boolean;
}

const FLAGS = new Set([
  "--url",
  "--storage",
  "--headless",
  "--timeout-ms",
  "--poll-ms",
  "--stay-signed-in",
  "--chromium-no-sandbox"
]);

const FALSE_VALUES = new Set(["false", "0", "no"]);

function readFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--") || !FLAGS.has(flag)) throw new LoginConfigError("flag");
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(flag, "");
      continue;
    }
    flags.set(flag, next);
    index += 1;
  }
  return flags;
}

function readBoolean(flag: string | undefined, envValue: string | undefined, fallback: boolean): boolean {
  if (flag !== undefined) {
    if (flag === "") return true;
    return !FALSE_VALUES.has(flag.toLowerCase());
  }
  if (envValue === undefined || envValue === "") return fallback;
  return !FALSE_VALUES.has(envValue.toLowerCase());
}

function readInteger(
  flag: string | undefined,
  envValue: string | undefined,
  fallback: number,
  code: "timeout" | "poll",
  min: number,
  max: number
): number {
  const raw = flag ?? envValue;
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new LoginConfigError(code);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new LoginConfigError(code);
  return value;
}

export function parseLoginConfig(argv: readonly string[], env: NodeJS.ProcessEnv): LoginConfig {
  const flags = readFlags(argv);
  const url = flags.get("--url") ?? env.MS_LOGIN_URL ?? "";
  if (!url) throw new LoginConfigError("url-missing");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LoginConfigError("url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new LoginConfigError("url");
  const storageStatePath = flags.get("--storage") ?? env.MS_LOGIN_STORAGE ?? "";
  if (!storageStatePath || storageStatePath.startsWith("--")) throw new LoginConfigError("storage");
  const noSandboxFlag = flags.has("--chromium-no-sandbox");
  const noSandboxEnv = env.MS_LOGIN_CHROMIUM_NO_SANDBOX;
  return {
    url,
    storageStatePath,
    headless: readBoolean(flags.get("--headless"), env.MS_LOGIN_HEADLESS, true),
    timeoutMs: readInteger(flags.get("--timeout-ms"), env.MS_LOGIN_TIMEOUT_MS, 180_000, "timeout", 1_000, 3_600_000),
    pollMs: readInteger(flags.get("--poll-ms"), env.MS_LOGIN_POLL_MS, 2_000, "poll", 50, 60_000),
    staySignedIn: readBoolean(flags.get("--stay-signed-in"), env.MS_LOGIN_STAY_SIGNED_IN, true),
    chromiumNoSandbox: noSandboxFlag || noSandboxEnv === "1" || noSandboxEnv === "true"
  };
}
