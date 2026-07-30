import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import pino, { multistream, type Logger } from "pino";

const gzipAsync = promisify(gzip);

export interface ServiceLoggerOptions {
  service: string;
  level?: string;
  logDirectory?: string;
}

export interface FileRotationOptions {
  maxBytes: number;
  maxFiles: number;
  compress?: boolean;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function rotationOptionsFromEnvironment(): FileRotationOptions {
  return {
    maxBytes: positiveInteger(process.env.LOG_ROTATE_MAX_BYTES, 50 * 1024 * 1024),
    maxFiles: positiveInteger(process.env.LOG_ROTATE_MAX_FILES, 10),
    compress: process.env.LOG_ROTATE_COMPRESS !== "false"
  };
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Rotates a closed or append-per-write file and keeps numbered archives. */
export async function rotateFileIfNeeded(filePath: string, options: FileRotationOptions, incomingBytes = 0): Promise<boolean> {
  const size = await fileSize(filePath);
  if (size === 0 || size + incomingBytes <= options.maxBytes) return false;

  await mkdir(path.dirname(filePath), { recursive: true });
  const suffix = options.compress === false ? "" : ".gz";
  await removeIfPresent(`${filePath}.${options.maxFiles}${suffix}`);
  for (let index = options.maxFiles - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}${suffix}`;
    try {
      await rename(source, `${filePath}.${index + 1}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  if (options.compress === false) {
    await rename(filePath, `${filePath}.1`);
  } else {
    const content = await readFile(filePath);
    await writeFile(`${filePath}.1.gz`, await gzipAsync(content));
    await unlink(filePath);
  }
  return true;
}

function createRotatingFileStream(filePath: string, options: FileRotationOptions): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      void (async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await rotateFileIfNeeded(filePath, options, content.byteLength);
        await appendFile(filePath, content);
      })().then(() => callback(), (error) => callback(error instanceof Error ? error : new Error(String(error))));
    }
  });
}

function findWorkspaceRoot(startDirectory: string): string {
  let directory = path.resolve(startDirectory);
  while (true) {
    if (existsSync(path.join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return path.resolve(startDirectory);
    directory = parent;
  }
}

function resolveLogDirectory(configuredDirectory: string): string {
  if (path.isAbsolute(configuredDirectory)) return configuredDirectory;
  return path.resolve(findWorkspaceRoot(process.cwd()), configuredDirectory);
}

function safePathSegment(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function createRoutedFileStream(logDirectory: string, service: string, rotation: FileRotationOptions): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        const line = chunk.toString();
        const record = JSON.parse(line) as { userId?: unknown; sessionId?: unknown };
        const userId = safePathSegment(record.userId);
        const sessionId = safePathSegment(record.sessionId);
        const filePath = userId && sessionId
          ? path.join(logDirectory, "users", userId, "sessions", sessionId, `${service}.log`)
          : userId
            ? path.join(logDirectory, "users", userId, "system", `${service}.log`)
            : path.join(logDirectory, "system", `${service}.log`);
        const destination = createRotatingFileStream(filePath, rotation);
        destination.end(line, callback);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}

/** Creates a structured text logger that writes to stdout and a service log file. */
export function createServiceLogger(options: ServiceLoggerOptions): Logger {
  const logDirectory = resolveLogDirectory(options.logDirectory ?? process.env.LOG_DIR ?? "data/logs");
  const file = createRoutedFileStream(logDirectory, options.service, rotationOptionsFromEnvironment());

  return pino(
    {
      level: options.level ?? process.env.LOG_LEVEL ?? "info",
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: ["req.headers.authorization", "req.headers.cookie"]
    },
    multistream([{ stream: process.stdout }, { stream: file }])
  );
}
