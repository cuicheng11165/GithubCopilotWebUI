import { access, chmod } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { publicBrowserMessage } from "./messages.js";
import { prepareRestrictedDirectory } from "./storage.js";
import type { LoginPage } from "./types.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function createPlaywrightLoginPage(input: {
  headless: boolean;
  storageStatePath: string;
  noSandbox: boolean;
}): Promise<{ page: LoginPage; close(): Promise<void> }> {
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: input.headless,
      ...(input.noSandbox ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {})
    });
    const hasState = await fileExists(input.storageStatePath);
    const context = await browser.newContext(hasState ? { storageState: input.storageStatePath } : {});
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const loginPage: LoginPage = {
      async goto(url: string) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      },
      async visible(selector: string) {
        return page.locator(selector).first().isVisible().catch(() => false);
      },
      async text(selector: string) {
        const locator = page.locator(selector).first();
        if (!(await locator.isVisible().catch(() => false))) return null;
        return locator.innerText().catch(() => null);
      },
      async fill(selector: string, value: string) {
        try {
          await page.locator(selector).first().fill(value);
        } catch {
          throw new Error("The sign-in field could not be filled");
        }
      },
      async click(selector: string) {
        try {
          await page.locator(selector).first().click();
        } catch {
          throw new Error("The sign-in control could not be used");
        }
      },
      async location() {
        return page.url();
      },
      async saveStorage(filePath: string) {
        await prepareRestrictedDirectory(filePath);
        await context.storageState({ path: filePath });
        await chmod(filePath, 0o600);
      }
    };
    return {
      page: loginPage,
      async close() {
        await browser?.close().catch(() => undefined);
      }
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    throw new Error(publicBrowserMessage(error));
  }
}
