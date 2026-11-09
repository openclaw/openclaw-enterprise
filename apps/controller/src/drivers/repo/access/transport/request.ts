import type { IncomingMessage } from "node:http";
import type { Denied, RequestHead } from "../backend-contracts.ts";

const NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const VALUE = /^[\x20-\x7e]*$/;
const REMOVED = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-length",
  "content-encoding",
]);
export type HeadInspection =
  | (Denied & Readonly<{ authorization?: string }>)
  | Readonly<{
      kind: "parsed";
      head: RequestHead;
      authorization: string | undefined;
      expectContinue: boolean;
    }>;

/** Inspect framing without reading a body or normalizing an adapter-owned target. */
export function inspectRequestHead(
  request: IncomingMessage,
  options: Readonly<{
    authority: string;
    receivedMonoMs: number;
    headerBytes: number;
    headerPairs: number;
    targetBytes: number;
  }>,
): HeadInspection {
  const deny = (status = 400): Denied => ({
    kind: "denied",
    status,
    code: status === 431 ? "limit-exceeded" : "unsupported-request",
  });
  const { method, url, rawHeaders, httpVersion } = request;
  if (
    httpVersion !== "1.1" ||
    !method ||
    !/^[A-Z]+$/.test(method) ||
    !url ||
    !url.startsWith("/") ||
    url.startsWith("//") ||
    !/^[\x21-\x7e]+$/.test(url) ||
    url.includes("#")
  ) {
    return deny();
  }
  if (url.length > options.targetBytes || rawHeaders.length > options.headerPairs * 2) {
    return deny(431);
  }
  if (rawHeaders.length % 2) {
    return deny();
  }
  const all = new Map<string, string>();
  let bytes = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name === undefined || value === undefined || !NAME.test(name) || !VALUE.test(value)) {
      return deny();
    }
    bytes += name.length + value.length + 4;
    if (bytes > options.headerBytes) {
      return deny(431);
    }
    const key = name.toLowerCase();
    if (all.has(key)) {
      return deny();
    }
    all.set(key, value);
  }
  // Past this point the fields are valid and unique, so a refusal can carry the one
  // Authorization field for log attribution (finding 2429); the Agent sees only the denial.
  const refuse = (status = 400): HeadInspection => {
    const authorization = all.get("authorization");
    return authorization === undefined ? deny(status) : { ...deny(status), authorization };
  };
  const host = all.get("host")?.toLowerCase();
  const authority = options.authority.toLowerCase();
  if (host !== authority && !(authority.indexOf(":") === -1 && host === `${authority}:443`)) {
    return refuse();
  }
  const connection = all.get("connection")?.toLowerCase();
  if (connection !== undefined && connection !== "close" && connection !== "keep-alive") {
    return refuse();
  }
  if (all.has("upgrade") || all.has("trailer") || all.has("te")) {
    return refuse();
  }
  const length = all.get("content-length");
  const transfer = all.get("transfer-encoding");
  if (length !== undefined && transfer !== undefined) {
    return refuse();
  }
  let framing: RequestHead["framing"] = Object.freeze({ kind: "none", bytes: undefined });
  if (length !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length))) {
      return refuse();
    }
    framing = Object.freeze({ kind: "length", bytes: Number(length) });
  } else if (transfer !== undefined) {
    if (transfer.toLowerCase() !== "chunked") {
      return refuse();
    }
    framing = Object.freeze({ kind: "chunked", bytes: undefined });
  }
  if (
    (method === "GET" || method === "HEAD") &&
    (framing.kind === "chunked" || (framing.bytes ?? 0) !== 0)
  ) {
    return refuse();
  }
  const encoding = all.get("content-encoding") ?? "identity";
  if (encoding !== "identity" && encoding !== "gzip") {
    return refuse(415);
  }
  const expect = all.get("expect");
  if (
    expect !== undefined &&
    (expect.toLowerCase() !== "100-continue" || framing.kind === "none")
  ) {
    return refuse(417);
  }
  const headers = Object.create(null) as Record<string, string>;
  for (const [name, value] of all) {
    if (!REMOVED.has(name)) {
      headers[name] = value;
    }
  }
  return Object.freeze({
    kind: "parsed",
    authorization: all.get("authorization"),
    expectContinue: expect !== undefined,
    head: Object.freeze({
      method,
      rawTarget: url,
      headers: Object.freeze(headers),
      receivedMonoMs: options.receivedMonoMs,
      contentEncoding: encoding,
      framing,
    }),
  });
}
