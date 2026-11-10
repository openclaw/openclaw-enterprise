import { isIP } from "node:net";
import { asRecord, hasControlCharacter } from "@openclaw-enterprise/utils";

type Wire = Record<string, unknown>;
const record = (input: unknown): Wire => asRecord(input) ?? {};

/** The normalized pre-credential view. Omitted headers and original framing
 * cannot be authorized here. Workspace is checked against the owner's mapping, never proof. */
export interface OpenShellHttpRequestView {
  readonly sandboxId: string;
  readonly requestId: string;
  readonly workspace: string;
  readonly target: {
    readonly reportedScheme: "https";
    readonly host: string;
    readonly port: number;
    readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly path: string;
    readonly query: string;
  };
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Uint8Array;
}

/** Model routes and captured requests share this DNS-only destination contract. */
export function isOpenShellRequestHost(host: unknown): host is string {
  return (
    typeof host === "string" &&
    host.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
      host,
    ) &&
    isIP(host) === 0
  );
}

function httpMethod(value: unknown): value is OpenShellHttpRequestView["target"]["method"] {
  return (
    typeof value === "string" && ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(value)
  );
}

export function readOpenShellHttpRequest(
  request: Wire,
  sandboxId: string,
): OpenShellHttpRequestView | undefined {
  const context = record(request.context);
  const target = record(request.target);
  const body = request.body ?? new Uint8Array();
  const rawHeaders = request.headers ?? [];
  const query = target.query ?? "";
  if (
    context.sandbox_id !== sandboxId ||
    typeof context.request_id !== "string" ||
    !/^[\x21-\x7e]{1,256}$/.test(context.request_id) ||
    typeof context.workspace !== "string" ||
    !/^[\x21-\x7e]{1,256}$/.test(context.workspace) ||
    target.scheme !== "https" ||
    !Number.isInteger(target.port) ||
    Number(target.port) < 1 ||
    Number(target.port) > 65535 ||
    !isOpenShellRequestHost(target.host) ||
    !httpMethod(target.method) ||
    typeof target.path !== "string" ||
    !/^\/[\x21-\x7e]{0,4095}$/.test(target.path) ||
    /[?#]/.test(target.path) ||
    typeof query !== "string" ||
    !/^[\x21-\x7e]{0,4096}$/.test(query) ||
    !(body instanceof Uint8Array) ||
    body.byteLength > 4 * 1024 * 1024 ||
    !Array.isArray(rawHeaders) ||
    rawHeaders.length > 128
  ) {
    return undefined;
  }
  const headers: [string, string][] = [];
  let headerBytes = 0;
  for (const raw of rawHeaders) {
    const { name, value } = record(raw);
    if (
      typeof name !== "string" ||
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) ||
      typeof value !== "string" ||
      hasControlCharacter(value) ||
      value.trim() !== value
    ) {
      return undefined;
    }
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (headerBytes > 64 * 1024) {
      return undefined;
    }
    headers.push([name, value]);
  }
  return {
    sandboxId,
    requestId: context.request_id,
    workspace: context.workspace,
    target: {
      reportedScheme: "https",
      host: target.host,
      port: Number(target.port),
      method: target.method,
      path: target.path,
      query,
    },
    headers,
    body,
  };
}
