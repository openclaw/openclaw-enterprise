import type { IncomingMessage } from "node:http";
import type { HeaderFields } from "../backend-contracts.ts";

const UNSAFE = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "authorization",
  "set-cookie",
  "www-authenticate",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "trailer",
  "upgrade",
]);
export function responseHeaders(
  message: IncomingMessage,
  maximumBytes: number,
  maximumPairs: number,
): HeaderFields {
  const headers = Object.create(null) as Record<string, string>;
  let bytes = 0;
  if (message.rawHeaders.length > maximumPairs * 2) {
    throw new Error("invalid-upstream");
  }
  for (let i = 0; i < message.rawHeaders.length; i += 2) {
    const name = message.rawHeaders[i]!.toLowerCase();
    const value = message.rawHeaders[i + 1]!;
    bytes += name.length + value.length + 4;
    if (bytes > maximumBytes || !/^[\x20-\x7e]*$/.test(value) || Object.hasOwn(headers, name)) {
      throw new Error("invalid-upstream");
    }
    headers[name] = value;
  }
  if (headers["content-length"] !== undefined && headers["transfer-encoding"] !== undefined) {
    throw new Error("invalid-upstream");
  }
  if (
    headers["content-length"] !== undefined &&
    !/^(0|[1-9][0-9]*)$/.test(headers["content-length"])
  ) {
    throw new Error("invalid-upstream");
  }
  if (
    headers["transfer-encoding"] !== undefined &&
    headers["transfer-encoding"].toLowerCase() !== "chunked"
  ) {
    throw new Error("invalid-upstream");
  }
  if (headers["content-encoding"] !== undefined && headers["content-encoding"] !== "identity") {
    throw new Error("invalid-upstream");
  }
  return headers;
}
export function safeResponseHeaders(headers: HeaderFields): Record<string, string> {
  const safe = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !/^[\x20-\x7e]*$/.test(value)) {
      throw new Error("invalid-upstream");
    }
    if (!UNSAFE.has(name.toLowerCase())) {
      safe[name.toLowerCase()] = value;
    }
  }
  safe.connection = "close";
  return safe;
}
