import { execFile, spawn } from "node:child_process";
import { access, readFile, realpath, readdir, stat } from "node:fs/promises";
import { constants, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const repositoryConfigSchema = z.object({
  repositories: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-_]{0,99}$/),
    displayName: z.string().min(1).max(120),
    path: z.string().min(1),
    enabled: z.boolean().default(true),
    sandboxImage: z.string().regex(/^[a-z0-9][a-z0-9._\/:@-]{0,254}$/i, "Invalid sandbox image reference").optional()
  })).min(1)
});

export interface RepositoryConfig {
  id: string;
  displayName: string;
  path: string;
  canonicalPath: string;
  enabled: boolean;
  sandboxImage: string | undefined;
}

export interface GitInfo {
  branch: string | null;
  headSha: string | null;
  dirty: boolean;
}

export interface SkillInfo {
  name: string;
  description: string | null;
  source: string;
  directory: string;
  warning: string | null;
  contentHash: string;
}

const SKILL_ROOTS = [".github/skills", ".agents/skills", ".claude/skills"] as const;
const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function sha256(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

export class RepositoryRegistry {
  private repositories = new Map<string, RepositoryConfig>();
  private watcher: FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;

  constructor(private readonly configPath: string) {}

  async load(): Promise<void> {
    const raw = await readFile(this.configPath, "utf8");
    const parsed = repositoryConfigSchema.parse(YAML.parse(raw));
    const next = new Map<string, RepositoryConfig>();
    const paths = new Set<string>();

    for (const item of parsed.repositories) {
      if (!path.isAbsolute(item.path)) throw new Error(`Repository ${item.id} path must be absolute`);
      await access(item.path, constants.R_OK);
      const canonicalPath = await realpath(item.path);
      if (!(await stat(canonicalPath)).isDirectory()) throw new Error(`Repository ${item.id} path is not a directory`);
      if (next.has(item.id)) throw new Error(`Duplicate repository id: ${item.id}`);
      if (paths.has(canonicalPath)) throw new Error(`Duplicate repository path: ${canonicalPath}`);
      next.set(item.id, { ...item, canonicalPath, sandboxImage: item.sandboxImage });
      paths.add(canonicalPath);
    }

    this.repositories = next;
  }

  watch(onError: (error: Error) => void = console.error): void {
    this.watcher?.close();
    this.watcher = watch(this.configPath, () => {
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => void this.load().catch(onError), 250);
    });
  }

  close(): void {
    this.watcher?.close();
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  list(): RepositoryConfig[] {
    return [...this.repositories.values()].filter((repository) => repository.enabled);
  }

  get(id: string): RepositoryConfig {
    const repository = this.repositories.get(id);
    if (!repository?.enabled) throw new Error("Repository not found or disabled");
    return repository;
  }
}

export async function getGitInfo(repository: RepositoryConfig): Promise<GitInfo> {
  const run = async (args: string[]) => (await execFileAsync("git", ["-C", repository.canonicalPath, ...args], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024
  })).stdout.trim();

  try {
    const [branch, headSha, statusOutput] = await Promise.all([
      run(["branch", "--show-current"]),
      run(["rev-parse", "HEAD"]),
      run(["status", "--porcelain=v1", "--untracked-files=normal"])
    ]);
    return { branch: branch || null, headSha: headSha || null, dirty: statusOutput.length > 0 };
  } catch {
    return { branch: null, headSha: null, dirty: false };
  }
}

function parseFrontmatter(content: string): { name: string | undefined; description: string | undefined } {
  if (!content.startsWith("---\n")) return { name: undefined, description: undefined };
  const end = content.indexOf("\n---", 4);
  if (end < 0) throw new Error("Unterminated YAML frontmatter");
  const parsed = z.object({ name: z.string().optional(), description: z.string().optional() }).passthrough().parse(
    YAML.parse(content.slice(4, end)) ?? {}
  );
  return { name: parsed.name, description: parsed.description };
}

export async function scanSkills(repository: RepositoryConfig): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];
  const seenNames = new Set<string>();

  for (const root of SKILL_ROOTS) {
    const absoluteRoot = path.join(repository.canonicalPath, root);
    let entries;
    try {
      entries = await readdir(absoluteRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const skillFile = path.join(absoluteRoot, entry.name, "SKILL.md");
      let content: string;
      try {
        content = await readFile(skillFile, "utf8");
      } catch {
        continue;
      }

      let name = entry.name;
      let description: string | null = null;
      let warning: string | null = null;
      try {
        const frontmatter = parseFrontmatter(content);
        name = frontmatter.name ?? entry.name;
        description = frontmatter.description ?? null;
        if (seenNames.has(name)) warning = `Duplicate skill name '${name}' was skipped`;
      } catch (error) {
        warning = error instanceof Error ? error.message : "Invalid skill frontmatter";
      }

      const item: SkillInfo = {
        name,
        description,
        source: `${root}/${entry.name}`,
        directory: path.join(absoluteRoot, entry.name),
        warning,
        contentHash: await sha256(content)
      };
      skills.push(item);
      if (!warning) seenNames.add(name);
    }
  }
  return skills;
}

export async function resolveRepositoryPath(repository: RepositoryConfig, requestedPath: string): Promise<string> {
  if (path.isAbsolute(requestedPath)) throw new Error("Absolute paths are not allowed");
  const segments = requestedPath.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment === ".." || EXCLUDED_SEGMENTS.has(segment))) {
    throw new Error("Path is outside the readable repository surface");
  }
  const candidate = path.join(repository.canonicalPath, ...segments);
  const canonical = await realpath(candidate);
  if (!isWithin(repository.canonicalPath, canonical)) throw new Error("Symlink escapes the repository root");
  return canonical;
}

export async function readRepositoryFile(repository: RepositoryConfig, requestedPath: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const file = await resolveRepositoryPath(repository, requestedPath);
  const fileStat = await stat(file);
  if (!fileStat.isFile()) throw new Error("Path is not a file");
  if (fileStat.size > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte read limit`);
  const buffer = await readFile(file);
  if (buffer.includes(0)) throw new Error("Binary files are not readable");
  return buffer.toString("utf8");
}

export async function listRepositoryTree(repository: RepositoryConfig, requestedPath = ".", depth = 2, maxEntries = 500): Promise<string[]> {
  const root = requestedPath === "." ? repository.canonicalPath : await resolveRepositoryPath(repository, requestedPath);
  const results: string[] = [];

  async function visit(directory: string, remainingDepth: number): Promise<void> {
    if (results.length >= maxEntries || remainingDepth < 0) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= maxEntries) break;
      if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(repository.canonicalPath, absolute);
      results.push(entry.isDirectory() ? `${relative}/` : relative);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(absolute, remainingDepth - 1);
    }
  }

  await visit(root, Math.max(0, Math.min(depth, 6)));
  return results;
}

export async function searchRepository(repository: RepositoryConfig, query: string, maxResults = 100): Promise<string> {
  if (!query.trim()) throw new Error("Search query is required");
  return new Promise((resolve, reject) => {
    const child = spawn("rg", ["--line-number", "--column", "--no-heading", "--color", "never", "--max-count", String(maxResults), "--glob", "!.git/**", "--glob", "!node_modules/**", "--", query, "."], {
      cwd: repository.canonicalPath,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk: Buffer) => { if (output.length < 512_000) output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { if (errorOutput.length < 8_000) errorOutput += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 1) resolve(output.trim());
      else reject(new Error(errorOutput || `rg exited with code ${code}`));
    });
  });
}
