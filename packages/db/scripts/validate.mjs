import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, "..");
const prismaCli = path.join(packageDirectory, "node_modules", "prisma", "build", "index.js");
const schemas = [
  { path: path.join(packageDirectory, "prisma", "schema.prisma"), url: "postgresql://validate:validate@localhost:5432/validate" },
  { path: path.join(packageDirectory, "prisma-sqlite", "schema.prisma"), url: "file:./validate.db" }
];

for (const schema of schemas) {
  const result = spawnSync(process.execPath, [prismaCli, "validate", "--schema", schema.path], {
    cwd: packageDirectory,
    env: { ...process.env, DATABASE_URL: schema.url },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
