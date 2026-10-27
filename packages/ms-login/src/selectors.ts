import type { LoginPage } from "./types.js";

export const selectors = {
  email: ["#i0116", "input[name=loginfmt]"],
  password: ["#i0118", "input[name=passwd]"],
  submit: ["#idSIButton9"],
  back: ["#idBtn_Back"],
  usernameError: ["#usernameError"],
  passwordError: ["#passwordError"],
  otp: ["#idTxtBx_SAOTCC_OTC", "input[name=otc]"],
  otpError: ["#idSpan_SAOTCC_Error_OTC"],
  numberMatch: ["#idRichContext_DisplaySign"],
  locked: ["#idA_IL_Locked"],
  staySignedIn: ["#KmsiDescription"],
  unsupported: ["#idUnsupported", "#idDiv_SAOTCS_Proofs", "#idDiv_SAASDS_Title"]
} as const;

export async function firstMatch(page: Pick<LoginPage, "visible">, candidates: readonly string[]): Promise<string | null> {
  for (const selector of candidates) {
    if (await page.visible(selector)) return selector;
  }
  return null;
}

export function matchNumber(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\d{1,3}$/.test(trimmed)) return trimmed;
  const groups = trimmed.match(/\d{1,3}/g);
  const only = groups?.length === 1 ? groups[0] : undefined;
  return only ?? null;
}
