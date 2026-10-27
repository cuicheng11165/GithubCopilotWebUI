import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { MICROSOFT_LOGIN_PURPOSE, MICROSOFT_LOGIN_TITLE } from "./login-copy.js";
import type { SecretConfirmRequest, SecretInputRequest, StepClient } from "./types.js";

export class SecureFormStepError extends Error {
  constructor(readonly code: "cancelled" | "expired" | "failed") {
    super(code);
    this.name = "SecureFormStepError";
  }
}

const STDIN_BRIDGE_SOURCE = `import { createConnection } from "node:net";
import { exit, stdin } from "node:process";
const socketPath = process.argv[2];
if (!socketPath) exit(1);
const chunks = [];
stdin.on("data", (chunk) => chunks.push(chunk));
stdin.on("error", () => exit(1));
stdin.on("end", () => {
  const payload = Buffer.concat(chunks);
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    payload.fill(0);
    exit(code);
  };
  const socket = createConnection(socketPath);
  socket.on("error", () => finish(1));
  socket.on("connect", () => socket.end(payload));
  socket.on("close", () => finish(0));
});
`;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface DeliveryStep {
  kind?: string;
  confirmed?: boolean;
  values?: Record<string, string>;
}

function wipe(buffers: readonly Buffer[]): void {
  for (const buffer of buffers) buffer.fill(0);
}

function statusFromStdout(stdout: string): { status: "submitted" | "cancelled" | "expired" | "failed"; delivered?: boolean } {
  const line = stdout.trim().split("\n").filter((item) => item.length > 0).at(-1) ?? "";
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return { status: "failed" };
    const record = parsed as { status?: unknown; delivered?: unknown };
    const status = record.status === "submitted" || record.status === "cancelled" || record.status === "expired" || record.status === "failed"
      ? record.status
      : "failed";
    const delivered = record.delivered === true || record.delivered === false ? record.delivered : undefined;
    return delivered === undefined ? { status } : { status, delivered };
  } catch {
    return { status: "failed" };
  }
}

function readDelivery(payload: Buffer, field: string | undefined): string | undefined {
  const chunks = [payload];
  const text = payload.toString("utf8");
  wipe(chunks);
  let parsed: { steps?: DeliveryStep[] };
  try {
    parsed = JSON.parse(text) as { steps?: DeliveryStep[] };
  } catch {
    throw new SecureFormStepError("failed");
  }
  const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  if (!field) {
    if (steps.some((step) => step.kind === "confirm" && step.confirmed === true)) return undefined;
    throw new SecureFormStepError("failed");
  }
  for (const step of steps) {
    const value = step.values?.[field];
    if (typeof value === "string") return value;
  }
  throw new SecureFormStepError("failed");
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") await chmod(socketPath, 0o600);
}

export async function requestSecureFormStep(input: {
  bin: string;
  targetSite: string;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  field?: { name: string; type: "email" | "password" | "otp"; label: string };
  confirm?: { id: string; prompt: string };
}): Promise<string | undefined> {
  const directory = await mkdtemp(path.join(input.tempRoot ?? tmpdir(), "ms-login-"));
  await chmod(directory, 0o700);
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\ms-login-${randomUUID()}`
    : path.join(directory, "stdin.sock");
  const bridgePath = path.join(directory, "stdin-bridge.mjs");
  await writeFile(bridgePath, STDIN_BRIDGE_SOURCE, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(bridgePath, 0o700);
  const sockets = new Set<Socket>();
  let payloadResolve: ((buffer: Buffer) => void) | undefined;
  const payloadPromise = new Promise<Buffer>((resolve) => {
    payloadResolve = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const chunks: Buffer[] = [];
    let size = 0;
    socket.on("data", (chunk: Buffer) => {
      const copy = Buffer.from(chunk);
      chunks.push(copy);
      size += copy.length;
      if (size > 1024 * 1024) socket.destroy();
    });
    socket.on("end", () => {
      socket.end();
      const payload = Buffer.concat(chunks);
      wipe(chunks);
      payloadResolve?.(payload);
      payloadResolve = undefined;
    });
    socket.on("error", () => undefined);
  });
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await listen(server, socketPath);
    const args = [
      "--title", MICROSOFT_LOGIN_TITLE,
      "--target", input.targetSite,
      "--purpose", MICROSOFT_LOGIN_PURPOSE,
      "--exec", `node ${shellQuote(bridgePath)} ${shellQuote(socketPath)}`
    ];
    if (input.field) args.push("--field", `${input.field.name}:${input.field.type}:${input.field.label}`);
    if (input.confirm) args.push("--confirm", `${input.confirm.id}:${input.confirm.prompt}`);
    child = spawn(process.execPath, [input.bin, ...args], {
      env: input.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const spawned = child;
    let stdout = "";
    spawned.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 65_536) stdout = stdout.slice(-65_536);
    });
    spawned.stderr?.on("data", () => undefined);
    spawned.on("error", () => undefined);
    await once(spawned, "close");
    const status = statusFromStdout(stdout);
    stdout = "";
    if (status.status !== "submitted" || status.delivered === false) {
      const code = status.status === "cancelled" || status.status === "expired" ? status.status : "failed";
      throw new SecureFormStepError(code);
    }
    const payload = await Promise.race([
      payloadPromise,
      new Promise<Buffer>((_, reject) => {
        timer = setTimeout(() => reject(new SecureFormStepError("failed")), 5_000);
      })
    ]);
    return readDelivery(payload, input.field?.name);
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

export function createSecureFormStepClient(input: {
  bin: string;
  targetUrl: string;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
}): StepClient {
  const targetSite = new URL(input.targetUrl).host;
  const shared = {
    bin: input.bin,
    targetSite,
    ...(input.env ? { env: input.env } : {}),
    ...(input.tempRoot ? { tempRoot: input.tempRoot } : {})
  };
  return {
    async input(request: SecretInputRequest) {
      const value = await requestSecureFormStep({
        ...shared,
        field: { name: request.id, type: request.type, label: request.label }
      });
      if (value === undefined) throw new SecureFormStepError("failed");
      return value;
    },
    async confirm(request: SecretConfirmRequest) {
      await requestSecureFormStep({
        ...shared,
        confirm: { id: request.id, prompt: request.prompt }
      });
    }
  };
}
