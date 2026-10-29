import { createHash } from "node:crypto";
import { hasControlCharacter } from "@openclaw-enterprise/utils";
import {
  googleCatalog,
  googleDiscoveryRequests,
  googleRouteCandidates,
  googleReleaseSha256,
  googleScopeFromString,
  googleSourcePathMatches,
  type GoogleOperation,
  type GoogleParameter,
  type GoogleRequestScope,
  type GoogleSchema,
} from "./google-operations.ts";
import { parseUnambiguousJson } from "../repo/credentials/json-members.ts";
import type { OpenShellOnlineHttpRequest } from "../egress-proxy/openshell-online-authority.ts";

// OpenShell removes routing, framing and credential headers before this RPC. Only these
// remaining client headers may accompany the request. Method and resource overrides refuse.
const clientHeaders = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "content-type",
  "pragma",
  "sec-fetch-mode",
  "user-agent",
  "x-goog-api-client",
]);

const forbiddenParameters = new Set([
  "access_token",
  "oauth_token",
  "key",
  "callback",
  "$.xgafv",
  "quotaUser",
  "userIp",
  "upload_protocol",
  "uploadType",
  "upload_id",
  "alt-svc",
  "method",
  "_method",
]);

function validValue(rule: GoogleParameter, value: string) {
  if (rule.enum && !rule.enum.includes(value)) {
    return false;
  }
  if (rule.type === "boolean") {
    return value === "false" || value === "true";
  }
  if (rule.type === "integer" || rule.type === "number") {
    if (!(rule.type === "integer" ? /^-?\d+$/ : /^-?\d+(?:\.\d+)?$/).test(value)) {
      return false;
    }
    const n = Number(value);
    return (
      Number.isFinite(n) &&
      (rule.minimum === undefined || n >= Number(rule.minimum)) &&
      (rule.maximum === undefined || n <= Number(rule.maximum))
    );
  }
  return (
    rule.type === "string" &&
    (!rule.pattern || new RegExp("^(?:" + rule.pattern + ")$").test(value))
  );
}

function matchesQuery(op: GoogleOperation, query: URLSearchParams) {
  const seen = new Set<string>();
  for (const [key, value] of query) {
    const rule = Object.hasOwn(op.query, key) && op.query[key];
    if (
      !rule ||
      forbiddenParameters.has(key) ||
      (seen.has(key) && !rule.repeated) ||
      !validValue(rule, value)
    ) {
      return false;
    }
    seen.add(key);
  }
  return Object.entries(op.query).every(([key, rule]) => !rule.required || seen.has(key));
}

function matchesJson(value: unknown, schema: GoogleSchema | undefined, depth = 0): boolean {
  if (!schema || depth > 64) {
    return false;
  }
  if (schema.$ref) {
    return matchesJson(value, googleCatalog.schemas[schema.$ref], depth + 1);
  }
  switch (schema.type) {
    case "array":
      return (
        Array.isArray(value) && value.every((item) => matchesJson(item, schema.items, depth + 1))
      );
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      if (schema.required?.some((key) => !Object.hasOwn(value, key))) {
        return false;
      }
      return Object.entries(value).every(([key, item]) => {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          return false;
        }
        const field =
          schema.properties && Object.hasOwn(schema.properties, key)
            ? schema.properties[key]
            : schema.additionalProperties;
        return matchesJson(item, field, depth + 1);
      });
    }
    case "any":
      // Discovery has no scalar union. Sheets defines cell values as string, number or
      // boolean, and skips null cells. Other opaque fields need their own reviewed shape.
      return (
        schema ===
          googleCatalog.schemas["sheets:v4/ValueRange"]?.properties?.values?.items?.items &&
        (value === null ||
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)))
      );
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string" && (!schema.enum || schema.enum.includes(value));
    default:
      return false;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
function matchesBody(op: GoogleOperation, request: OpenShellOnlineHttpRequest) {
  if (!op.requestSchema) {
    return request.body.length === 0;
  }
  const type = request.headers.find(([name]) => name === "content-type")?.[1];
  if (
    !type ||
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(type) ||
    request.body.length === 0
  ) {
    return false;
  }
  const body = parseUnambiguousJson(utf8.decode(request.body));
  // Workspace batchUpdate accepts a list of oneof subrequests. The schema enumerates the
  // released actions. Refuse ambiguous entries even if each field independently type checks.
  if (
    op.path.endsWith(":batchUpdate") &&
    body &&
    typeof body === "object" &&
    "requests" in body &&
    (!Array.isArray(body.requests) ||
      !body.requests.every(
        (item: unknown) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          Object.keys(item).length === 1,
      ))
  ) {
    return false;
  }
  return matchesJson(body, googleCatalog.schemas[op.requestSchema]);
}

function validGoogleRequest(
  scope: GoogleRequestScope,
  request: OpenShellOnlineHttpRequest,
): boolean {
  const { host, path, query, port, reportedScheme, method } = request.target;
  const names = request.headers.map(([name]) => name);
  if (
    reportedScheme !== "https" ||
    port !== 443 ||
    new Set(names).size !== names.length ||
    names.some((name) => !clientHeaders.has(name))
  ) {
    return false;
  }
  // Keep the supervisor's wire path and the Google router on the same segments. This also
  // refuses doubled encodings, literal traversal, empty segments and escaped separators.
  const decoded = path.split("/").map((part) => decodeURIComponent(part));
  if (
    decoded
      .slice(1)
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[/%\\;#?]/.test(part) ||
          hasControlCharacter(part),
      )
  ) {
    return false;
  }
  if (path.startsWith("/discovery/v1/apis") || path === "/$discovery/rest") {
    return (
      method === "GET" &&
      !request.body.length &&
      googleDiscoveryRequests(scope).some(
        (r) => r.host === host && r.path === path && r.query === query,
      )
    );
  }
  if (host !== scope.host || !googleSourcePathMatches(scope.path, path)) {
    return false;
  }
  if (
    query &&
    (query.includes(";") ||
      query.split("&").some((p) => !p.includes("=") || p.startsWith("=")) ||
      /%(?![0-9a-fA-F]{2})/.test(query))
  ) {
    return false;
  }
  const params = new URLSearchParams(query);
  const candidates = googleRouteCandidates("https://" + host, method, decoded.join("/"));
  return (
    candidates.length > 0 &&
    candidates.every(({ id, supported }) => {
      if (!id || !supported) {
        return false;
      }
      const operation = googleCatalog.operations[id]!;
      const grants = operation.scopes.filter((s) => scope.scopes.includes(s));
      if (!grants.length) {
        return false;
      }
      // alt=media switches a Drive metadata method to content download. Google's method-level
      // alternatives alone cannot express this distinction. Other media transports need their
      // own reviewed content grant; Google's resource ACL still decides which files are visible.
      if (
        params.get("alt") === "media" &&
        id !== "drive:v3/drive.files.export" &&
        id !== "keep:v1/keep.media.download" &&
        (!/^drive:v[23]\/drive\.(files|revisions)\.get$/.test(id) ||
          !grants.some((scope) =>
            [
              "https://www.googleapis.com/auth/drive",
              "https://www.googleapis.com/auth/drive.file",
              "https://www.googleapis.com/auth/drive.readonly",
            ].includes(scope),
          ))
      ) {
        return false;
      }
      // Gmail restricts q and message content on a metadata-only grant even though the method
      // accepts that scope. Apply this before sending a possibly more powerful bearer.
      if (
        grants.every((s) => s === "https://www.googleapis.com/auth/gmail.metadata") &&
        (params.has("q") ||
          ((id.endsWith("messages.get") || id.endsWith("threads.get")) &&
            !["minimal", "metadata"].includes(params.get("format") ?? "")))
      ) {
        return false;
      }
      return matchesQuery(operation, params) && matchesBody(operation, request);
    })
  );
}

interface PluginRequestPolicy {
  acceptsScope(scope: string): boolean;
  allows(request: OpenShellOnlineHttpRequest): boolean;
}

// The guard loads reviewed policies from this image. The signed supervisor selects one
// by its release digest and supplies the source envelope admitted for that deployment.
const releasedPolicies = new Map<string, PluginRequestPolicy>([
  [
    googleReleaseSha256,
    {
      acceptsScope: (raw) => googleScopeFromString(raw) !== undefined,
      allows(request) {
        const scope = googleScopeFromString(request.bindingConfig);
        return scope !== undefined && validGoogleRequest(scope, request);
      },
    },
  ],
]);

// The Gateway advertises one implementation version per registration. Pin the whole set
// at admission and each individual release in the Sandbox's binding.
const releases = [...releasedPolicies.keys()].sort();
export const managedPluginGuardVersion =
  releases.length === 1
    ? releases[0]!
    : createHash("sha256").update(releases.join("\n")).digest("hex");

export function acceptsPluginRequestScope(id: string, scope: string): boolean {
  return releasedPolicies.get(id)?.acceptsScope(scope) === true;
}

export function allowsPluginRequest(request: OpenShellOnlineHttpRequest): boolean {
  try {
    return releasedPolicies.get(request.bindingId)?.allows(request) === true;
  } catch {
    // Malformed percent encodings, JSON and unsupported schema projections fail closed.
    return false;
  }
}
