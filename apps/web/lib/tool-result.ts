type JsonRecord = Record<string, unknown>;

export type ToolResultView = {
  status: "success" | "error";
  title: string;
  summary: string;
  detail: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function nestedResult(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const result = isRecord(value.result) ? value.result : value;
  const content = typeof result.content === "string" ? parseJson(result.content) : result.content;
  return isRecord(content) ? content : result;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resultContentText(value: JsonRecord | null): string {
  if (!isRecord(value?.result)) return "";
  const content = value.result.content;
  if (typeof content !== "string") return "";
  const parsed = parseJson(content);
  return typeof parsed === "string" ? parsed.trim() : "";
}

function preview(value: string, maxLength = 220): string {
  const normalized = value.trim().replace(/\r\n/g, "\n");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

function technicalDetail(content: string, parsed: unknown): string {
  if (typeof parsed === "string") return content;
  return JSON.stringify(parsed, null, 2);
}

export function parseToolResult(content: string): ToolResultView {
  const parsed = parseJson(content);
  const outer = isRecord(parsed) ? parsed : null;
  const execution = nestedResult(parsed);
  const exitCode = typeof execution?.exitCode === "number" ? execution.exitCode : null;
  const timedOut = execution?.timedOut === true;
  const succeeded = outer?.success !== false && exitCode !== null ? exitCode === 0 && !timedOut : outer?.success !== false && !timedOut;
  const stdout = textValue(execution?.stdout);
  const stderr = textValue(execution?.stderr);
  const message = textValue(execution?.message) || textValue(execution?.error) || textValue(outer?.message) || textValue(outer?.error);
  const resultContent = resultContentText(outer);
  const directContent = typeof parsed === "string" ? parsed.trim() : "";

  let summary = "";
  if (timedOut) summary = "The command timed out.";
  else if (!succeeded) summary = stderr || message || (exitCode === null ? "The tool could not complete the request." : `The command exited with code ${exitCode}.`);
  else summary = stdout || message || resultContent || directContent || "Completed successfully.";

  if (execution?.truncated === true) summary = `${summary}\nOutput was truncated.`;

  const isCommand = execution !== null && ("exitCode" in execution || "stdout" in execution || "stderr" in execution);
  return {
    status: succeeded ? "success" : "error",
    title: isCommand ? (succeeded ? "Command completed" : "Command failed") : (succeeded ? "Tool completed" : "Tool failed"),
    summary: preview(summary),
    detail: technicalDetail(content, parsed)
  };
}
