import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PythonLauncher {
  executable: string;
  prefixArgs: string[];
  shellPrefix: string;
}

type CommandFinder = (command: string) => Promise<boolean>;

async function commandOnPath(command: string): Promise<boolean> {
  try {
    await execFileAsync("where.exe", [command], { timeout: 5_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function resolvePythonLauncher(
  platform = process.platform,
  finder: CommandFinder = commandOnPath
): Promise<PythonLauncher> {
  if (platform !== "win32") return { executable: "python3", prefixArgs: [], shellPrefix: "python3" };
  if (await finder("python.exe")) return { executable: "python", prefixArgs: [], shellPrefix: "python" };
  if (await finder("py.exe")) return { executable: "py", prefixArgs: ["-3"], shellPrefix: "py -3" };
  throw new Error("Python 3 was not found on PATH. Install Python for Windows or enable the py launcher.");
}
