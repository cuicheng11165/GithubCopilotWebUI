export async function postSandboxJson<T>(input: {
  baseUrl: string;
  token: string;
  pathname: string;
  body?: unknown;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<T> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const init: RequestInit = {
    method: "POST",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(input.timeoutMs)
  };
  if (input.body !== undefined) init.body = JSON.stringify(input.body);
  const response = await fetchImpl(`${input.baseUrl}${input.pathname}`, init);
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Sandbox runner returned ${response.status}`);
  return result;
}
