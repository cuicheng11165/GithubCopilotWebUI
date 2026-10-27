import { readFile } from "node:fs/promises";
import { writeJsonFileRestricted } from "./storage.js";
import type { LoginPage } from "./types.js";

export type FixtureScenario = "otp" | "number" | "none" | "unsupported";

const LOGIN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const LOCKED_EMAIL = "locked@contoso.com";
const UNKNOWN_EMAIL = "nobody@contoso.com";
const WRONG_PASSWORD = "bad-password-value";
const REJECTED_CODE = "000000";

type ScreenName =
  | "email"
  | "password"
  | "password-error"
  | "unknown-account"
  | "locked"
  | "otp"
  | "otp-error"
  | "number-match"
  | "stay-signed-in"
  | "unsupported"
  | "success";

export interface FixturePage extends LoginPage {
  releaseNumberMatch(): void;
  filledSelectors(): readonly string[];
  clicks(): readonly { screen: string; selector: string }[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function selectorMatches(html: string, selector: string): boolean {
  if (selector.startsWith("#")) {
    const id = selector.slice(1);
    return new RegExp(`\\bid=["']${escapeRegExp(id)}["']`).test(html);
  }
  const named = /^([a-z]+)\[name=(?:"([^"]+)"|'([^']+)'|([^\]]+))\]$/i.exec(selector);
  if (!named) return false;
  const tag = named[1] ?? "";
  const name = named[2] ?? named[3] ?? named[4] ?? "";
  return new RegExp(`<${tag}\\b[^>]*\\bname=["']${escapeRegExp(name)}["']`, "i").test(html);
}

function elementText(html: string, selector: string): string | null {
  if (!selector.startsWith("#") || !selectorMatches(html, selector)) return null;
  const id = selector.slice(1);
  const match = new RegExp(`\\bid=["']${escapeRegExp(id)}["'][^>]*>([^<]*)`).exec(html);
  return match?.[1]?.trim() ?? "";
}

function sectionsOf(html: string): Map<string, string> {
  const sections = new Map<string, string>();
  const pattern = /<section\s+data-screen="([^"]+)"[^>]*>([\s\S]*?)<\/section>/gi;
  for (const match of html.matchAll(pattern)) {
    const name = match[1];
    const body = match[2];
    if (name && body !== undefined) sections.set(name, body);
  }
  return sections;
}

export async function loadFixtureHtml(): Promise<string> {
  return readFile(new URL("./fixture/login.html", import.meta.url), "utf8");
}

export async function createFixturePage(options: {
  scenario: FixtureScenario;
  html?: string;
  emailByName?: boolean;
}): Promise<FixturePage> {
  const sections = sectionsOf(options.html ?? await loadFixtureHtml());
  for (const name of ["email", "password", "password-error", "unknown-account", "locked", "otp", "otp-error", "number-match", "stay-signed-in", "unsupported"]) {
    if (!sections.has(name)) throw new Error(`Fixture is missing the ${name} screen`);
  }
  let screen: ScreenName = "email";
  let location = LOGIN_URL;
  let targetUrl = "https://contoso.sharepoint.com/";
  const values = new Map<string, string>();
  const filled: string[] = [];
  const clickLog: { screen: string; selector: string }[] = [];

  const htmlFor = (): string => (screen === "success" ? "" : sections.get(screen) ?? "");
  const visible = (selector: string): boolean => {
    if (options.emailByName && screen === "email" && selector === "#i0116") return false;
    return selectorMatches(htmlFor(), selector);
  };
  const readValue = (...selectors: string[]): string => {
    for (const selector of selectors) {
      const value = values.get(selector);
      if (value !== undefined) return value;
    }
    return "";
  };

  const page: FixturePage = {
    async goto(url: string) {
      targetUrl = url;
      location = LOGIN_URL;
      screen = "email";
      values.clear();
    },
    async visible(selector: string) {
      return visible(selector);
    },
    async text(selector: string) {
      if (!visible(selector)) return null;
      return elementText(htmlFor(), selector);
    },
    async fill(selector: string, value: string) {
      if (!visible(selector)) throw new Error("The sign-in field could not be filled");
      values.set(selector, value);
      filled.push(selector);
    },
    async click(selector: string) {
      if (!visible(selector)) throw new Error("The sign-in control could not be used");
      clickLog.push({ screen, selector });
      if (screen === "email" && selector === "#idSIButton9") {
        const email = readValue("#i0116", "input[name=loginfmt]");
        values.clear();
        if (email === LOCKED_EMAIL) screen = "locked";
        else if (email === UNKNOWN_EMAIL || email === "") screen = "unknown-account";
        else screen = "password";
        return;
      }
      if (screen === "password" && selector === "#idSIButton9") {
        const password = readValue("#i0118", "input[name=passwd]");
        values.clear();
        if (password === WRONG_PASSWORD) screen = "password-error";
        else if (options.scenario === "otp") screen = "otp";
        else if (options.scenario === "number") screen = "number-match";
        else if (options.scenario === "unsupported") screen = "unsupported";
        else screen = "stay-signed-in";
        return;
      }
      if (screen === "otp" && selector === "#idSIButton9") {
        const code = readValue("#idTxtBx_SAOTCC_OTC", "input[name=otc]");
        values.clear();
        screen = code === REJECTED_CODE ? "otp-error" : "stay-signed-in";
        return;
      }
      if (screen === "stay-signed-in" && (selector === "#idSIButton9" || selector === "#idBtn_Back")) {
        values.clear();
        location = targetUrl;
        screen = "success";
      }
    },
    async location() {
      return location;
    },
    async saveStorage(filePath: string) {
      await writeJsonFileRestricted(filePath, {
        cookies: [{ name: "ESTSAUTH", value: "fixture-session", domain: ".login.microsoftonline.com", path: "/" }],
        origins: []
      });
    },
    releaseNumberMatch() {
      if (screen === "number-match") screen = "stay-signed-in";
    },
    filledSelectors() {
      return filled;
    },
    clicks() {
      return clickLog;
    }
  };
  return page;
}

export const fixtureSentinels = {
  lockedEmail: LOCKED_EMAIL,
  unknownEmail: UNKNOWN_EMAIL,
  wrongPassword: WRONG_PASSWORD,
  rejectedCode: REJECTED_CODE
} as const;
