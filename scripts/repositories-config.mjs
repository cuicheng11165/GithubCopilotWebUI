import { existsSync } from "node:fs";
import path from "node:path";

export function resolveRepositoriesConfig(root, env = process.env) {
  const configured = env.REPOSITORIES_CONFIG ?? path.join(root, "config/repositories.yaml");
  return path.resolve(root, configured);
}

export function missingRepositoriesConfigMessage(configPath) {
  return [
    `Repository config not found: ${configPath}`,
    "Copy the tracked example and set local repository paths before startup:",
    "  cp config/repositories.example.yaml config/repositories.yaml",
    "On Windows:",
    "  Copy-Item config\\repositories.example.yaml config\\repositories.yaml"
  ].join("\n");
}

export function assertRepositoriesConfig(root, env = process.env) {
  const configPath = resolveRepositoriesConfig(root, env);
  if (existsSync(configPath)) return configPath;
  throw new Error(missingRepositoriesConfigMessage(configPath));
}
