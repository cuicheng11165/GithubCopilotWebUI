import { gzipSync, gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rotateFileIfNeeded } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("rotateFileIfNeeded", () => {
  it("compresses a full log and shifts existing archives", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "logging-rotation-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "worker.log");
    await writeFile(filePath, "newest");
    await writeFile(`${filePath}.1.gz`, gzipSync("older"));

    await expect(rotateFileIfNeeded(filePath, { maxBytes: 6, maxFiles: 2, compress: true }, 1)).resolves.toBe(true);

    expect(gunzipSync(await readFile(`${filePath}.1.gz`)).toString()).toBe("newest");
    expect(gunzipSync(await readFile(`${filePath}.2.gz`)).toString()).toBe("older");
  });

  it("leaves a file in place while it remains below the threshold", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "logging-rotation-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "api.log");
    await writeFile(filePath, "small");

    await expect(rotateFileIfNeeded(filePath, { maxBytes: 10, maxFiles: 2 }, 2)).resolves.toBe(false);
    await expect(readFile(filePath, "utf8")).resolves.toBe("small");
  });
});
