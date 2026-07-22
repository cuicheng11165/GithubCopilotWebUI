import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, "..");
const schemaPath = path.join(packageDirectory, "prisma-sqlite", "schema.prisma");
const prismaCli = path.join(packageDirectory, "node_modules", "prisma", "build", "index.js");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl?.startsWith("file:")) {
  throw new Error("SQLite commands require DATABASE_URL to begin with file:");
}

const withoutQuery = decodeURIComponent(databaseUrl.slice("file:".length).split("?", 1)[0]);
const databasePath = path.isAbsolute(withoutQuery)
  ? withoutQuery
  : path.resolve(path.dirname(schemaPath), withoutQuery);

mkdirSync(path.dirname(databasePath), { recursive: true });
closeSync(openSync(databasePath, "a"));

const result = spawnSync(process.execPath, [prismaCli, ...process.argv.slice(2), "--schema", schemaPath], {
  cwd: packageDirectory,
  env: process.env,
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
