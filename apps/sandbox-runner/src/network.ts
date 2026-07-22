import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

const BLOCKED_RANGES = new Set([
  "unspecified", "broadcast", "multicast", "linkLocal", "loopback", "private", "carrierGradeNat", "reserved", "uniqueLocal"
]);

export function isBlockedAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    const range = parsed.range();
    return BLOCKED_RANGES.has(range) || address === "169.254.169.254";
  } catch {
    return true;
  }
}

export async function validatePublicUrl(value: string): Promise<URL> {
  return (await resolvePublicUrl(value)).url;
}

async function resolvePublicUrl(value: string) {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error("URL resolves to a blocked network address");
  }
  return { url, addresses };
}

export interface PublicUrlResponse {
  status: number;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

export async function requestPublicUrl(value: string, maxBytes: number): Promise<PublicUrlResponse> {
  const { url, addresses } = await resolvePublicUrl(value);
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    const family = typeof options === "number" ? options : options.family ?? 0;
    const candidates = family === 0 ? addresses : addresses.filter((item) => item.family === family);
    if (candidates.length === 0) return callback(new Error("No validated address matches the requested IP family"), "", 0);
    if (typeof options === "object" && options.all) return callback(null, candidates);
    return callback(null, candidates[0]!.address, candidates[0]!.family);
  };

  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: "GET",
      lookup: pinnedLookup,
      headers: { "User-Agent": "copilot-web-sandbox/0.1", Accept: "*/*" }
    }, (response) => {
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.resume();
        reject(new Error("Redirects are disabled; request the target URL explicitly"));
        return;
      }
      const chunks: Buffer[] = [];
      let storedBytes = 0;
      let totalBytes = 0;
      response.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (storedBytes < maxBytes) {
          const kept = chunk.subarray(0, maxBytes - storedBytes);
          chunks.push(kept);
          storedBytes += kept.length;
        }
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        contentType: typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : null,
        body: Buffer.concat(chunks).toString("utf8"),
        truncated: totalBytes > maxBytes
      }));
      response.on("error", reject);
    });
    request.setTimeout(30_000, () => request.destroy(new Error("URL request timed out")));
    request.on("error", reject);
    request.end();
  });
}
