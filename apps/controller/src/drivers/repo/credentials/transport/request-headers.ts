import { validateHeaderName, validateHeaderValue } from "node:http";
import type { HeaderFields, RequestHead } from "../backend-contracts.ts";

const RESERVED = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Node can send this field before the dispatch gate opens.
  "expect",
  "cookie",
  "content-length",
  "content-encoding",
  "accept-encoding",
]);

/** Canonicalize adapter fields before adding the sender-owned transport fields. */
export function createUpstreamHeaders(
  input: HeaderFields,
  options: Readonly<{
    authority: string;
    head: RequestHead;
    maximumBytes: number;
    maximumPairs: number;
  }>,
): HeaderFields {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("invalid-upstream-headers");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new Error("invalid-upstream-headers");
  }
  for (const name in input) {
    if (!Object.hasOwn(input, name)) {
      throw new Error("invalid-upstream-headers");
    }
  }
  const names = Reflect.ownKeys(input);
  if (names.length > options.maximumPairs) {
    throw new Error("invalid-upstream-headers");
  }
  const seen = new Set<string>();
  const headers = Object.create(null) as Record<string, string>;
  let bytes = 0;
  for (const name of names) {
    if (typeof name !== "string") {
      throw new Error("invalid-upstream-headers");
    }
    const field = Object.getOwnPropertyDescriptor(input, name);
    if (!field?.enumerable || !Object.hasOwn(field, "value") || typeof field.value !== "string") {
      throw new Error("invalid-upstream-headers");
    }
    const value = field.value;
    validateHeaderName(name);
    validateHeaderValue(name, value);
    const canonical = name.toLowerCase();
    bytes += name.length + value.length + 4;
    if (!/^[\x20-\x7e]*$/.test(value) || seen.has(canonical) || bytes > options.maximumBytes) {
      throw new Error("invalid-upstream-headers");
    }
    seen.add(canonical);
    if (!RESERVED.has(canonical)) {
      headers[canonical] = value;
    }
  }
  headers.host = options.authority;
  headers.connection = "close";
  headers["accept-encoding"] = "identity";
  const { framing, contentEncoding } = options.head;
  if (framing.kind === "none") {
    headers["content-length"] = "0";
  } else if (framing.kind === "length" && contentEncoding === "identity") {
    const length = framing.bytes;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
      throw new Error("invalid-upstream-headers");
    }
    headers["content-length"] = String(length);
  } else {
    headers["transfer-encoding"] = "chunked";
  }
  const fields = Object.entries(headers);
  if (
    fields.length > options.maximumPairs ||
    fields.reduce((sum, [name, value]) => sum + name.length + value.length + 4, 0) >
      options.maximumBytes
  ) {
    throw new Error("invalid-upstream-headers");
  }
  return Object.freeze(headers);
}
