import { existsSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import pino, { multistream, type Logger } from "pino";

export interface ServiceLoggerOptions {
  service: string;
  level?: string;
  logDirectory?: string;
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

function createRoutedFileStream(logDirectory: string, service: string): Writable {
  const destinations = new Map<string, ReturnType<typeof pino.destination>>();
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
        let destination = destinations.get(filePath);
        if (!destination) {
          destination = pino.destination({ dest: filePath, mkdir: true, sync: false });
          destinations.set(filePath, destination);
        }
        destination.write(line);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}

/** Creates a structured text logger that writes to stdout and a service log file. */
export function createServiceLogger(options: ServiceLoggerOptions): Logger {
  const logDirectory = resolveLogDirectory(options.logDirectory ?? process.env.LOG_DIR ?? "data/logs");
  const file = createRoutedFileStream(logDirectory, options.service);

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
