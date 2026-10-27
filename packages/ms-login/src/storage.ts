import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

async function directoryExists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}

export async function prepareRestrictedDirectory(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  const created = !(await directoryExists(directory));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (created) await chmod(directory, 0o700);
}

export async function writeJsonFileRestricted(filePath: string, value: unknown): Promise<void> {
  await prepareRestrictedDirectory(filePath);
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}
