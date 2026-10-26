import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requestSecureFormStep, shellQuote } from "./secure-form-client.js";

const REAL_EMAIL = "real@contoso.com";
const DECOY = "decoy-secret";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const FAKE_BIN = `import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const execIndex = args.indexOf("--exec");
const command = execIndex === -1 ? undefined : args[execIndex + 1];
const decoy = ${JSON.stringify({ status: "submitted", delivered: true, password: DECOY, values: { email: DECOY }, stdout: DECOY })};
if (process.env.FAKE_FORM_MODE === "cancel" || !command) {
  process.stdout.write(JSON.stringify({ status: "cancelled", reason: "stopped", password: ${JSON.stringify(DECOY)} }) + "\\n");
  process.exit(1);
}
const confirmIndex = args.indexOf("--confirm");
const fieldIndex = args.indexOf("--field");
let steps;
if (confirmIndex !== -1) steps = [{ id: "approve", kind: "confirm", confirmed: true }];
else {
  const spec = args[fieldIndex + 1] || "email:email:Email";
  const name = spec.split(":")[0];
  steps = [{ id: name, kind: "input", values: { [name]: ${JSON.stringify(REAL_EMAIL)} } }];
}
const child = spawn("/bin/sh", ["-lc", command], { stdio: ["pipe", "ignore", "ignore"] });
child.stdin.end(JSON.stringify({ formId: "11111111-1111-4111-8111-111111111111", targetSite: "contoso.sharepoint.com", purpose: "test", steps }) + "\\n");
child.on("exit", () => {
  process.stdout.write(JSON.stringify(decoy) + "\\n");
  process.exit(0);
});
`;

async function writeFakeBin(): Promise<{ bin: string; tempRoot: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), "ms-login-client-"));
  directories.push(parent);
  const tempRoot = path.join(parent, "space dir");
  await mkdir(tempRoot);
  const bin = path.join(parent, "fake-bin.mjs");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(bin, FAKE_BIN, { mode: 0o700 });
  return { bin, tempRoot };
}

describe("secure form stdin client", () => {
  it("quotes shell arguments", () => {
    expect(shellQuote("/tmp/a b")).toBe("'/tmp/a b'");
    expect(shellQuote("/tmp/a'b")).toBe(`'/tmp/a'\\''b'`);
  });

  it("reads the stdin payload and ignores a decoy on helper stdout", async () => {
    const { bin, tempRoot } = await writeFakeBin();
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const value = await requestSecureFormStep({
        bin,
        targetSite: "contoso.sharepoint.com",
        tempRoot,
        env: { PATH: process.env.PATH ?? "" },
        field: { name: "email", type: "email", label: "Work email" }
      });
      expect(value).toBe(REAL_EMAIL);
      expect(value).not.toBe(DECOY);
      expect(writes.join("")).not.toContain(DECOY);
      expect(writes.join("")).not.toContain(REAL_EMAIL);
      const confirmed = requestSecureFormStep({
        bin,
        targetSite: "contoso.sharepoint.com",
        tempRoot,
        env: { PATH: process.env.PATH ?? "" },
        confirm: { id: "approve", prompt: "Approve sign-in request 42 in Microsoft Authenticator, then continue." }
      });
      await expect(confirmed).resolves.toBeUndefined();
    } finally {
      process.stdout.write = original;
    }
  });

  it("returns when the form is cancelled", async () => {
    const { bin, tempRoot } = await writeFakeBin();
    await expect(requestSecureFormStep({
      bin,
      targetSite: "contoso.sharepoint.com",
      tempRoot,
      env: { PATH: process.env.PATH ?? "", FAKE_FORM_MODE: "cancel" },
      field: { name: "password", type: "password", label: "Password" }
    })).rejects.toMatchObject({ code: "cancelled", message: "cancelled" });
  }, 2_000);
});
