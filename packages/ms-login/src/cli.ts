#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { LoginConfigError, parseLoginConfig } from "./config.js";
import { runMicrosoftLogin } from "./flow.js";
import { CONFIG_MESSAGES, publicBrowserMessage, type MicrosoftLoginResult } from "./messages.js";
import { createPlaywrightLoginPage } from "./playwright-session.js";
import { createSecureFormStepClient } from "./secure-form-client.js";

function emit(result: { ok: boolean; code: string; message: string; storageStatePath?: string }): void {
  const payload: { ok: boolean; code: string; message: string; storageStatePath?: string } = {
    ok: result.ok,
    code: result.code,
    message: result.message
  };
  if (result.storageStatePath) payload.storageStatePath = result.storageStatePath;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<number> {
  let config;
  try {
    config = parseLoginConfig(process.argv.slice(2), process.env);
  } catch (error) {
    const code = error instanceof LoginConfigError ? error.code : "flag";
    emit({ ok: false, code: "failed", message: CONFIG_MESSAGES[code] });
    return 1;
  }
  const bin = process.env.COPILOT_SECURE_FORM_BIN;
  if (!bin) {
    emit({ ok: false, code: "failed", message: CONFIG_MESSAGES.bin });
    return 1;
  }
  let session: Awaited<ReturnType<typeof createPlaywrightLoginPage>> | undefined;
  try {
    session = await createPlaywrightLoginPage({
      headless: config.headless,
      storageStatePath: config.storageStatePath,
      noSandbox: config.chromiumNoSandbox
    });
    const result: MicrosoftLoginResult = await runMicrosoftLogin({
      page: session.page,
      secrets: createSecureFormStepClient({ bin, targetUrl: config.url }),
      targetUrl: config.url,
      storageStatePath: config.storageStatePath,
      timeoutMs: config.timeoutMs,
      pollMs: config.pollMs,
      staySignedIn: config.staySignedIn
    });
    emit(result);
    return result.ok ? 0 : 1;
  } catch (error) {
    emit({ ok: false, code: "failed", message: publicBrowserMessage(error) });
    return 1;
  } finally {
    await session?.close();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  main().then((code) => {
    process.exit(code);
  }).catch(() => {
    emit({ ok: false, code: "failed", message: "Microsoft sign-in failed." });
    process.exit(1);
  });
}
