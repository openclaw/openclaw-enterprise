import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { asRecord } from "@openclaw-enterprise/utils";
import type { CredentialSourceAttachment } from "@openclaw-enterprise/contracts";

export type GoogleRequestScope = NonNullable<CredentialSourceAttachment["requestScope"]>;

export interface GoogleParameter {
  type?: string;
  enum?: string[];
  required?: boolean;
  repeated?: boolean;
  pattern?: string;
  minimum?: string | number;
  maximum?: string | number;
}
export interface GoogleSchema {
  type?: string;
  $ref?: string;
  properties?: Record<string, GoogleSchema>;
  items?: GoogleSchema;
  additionalProperties?: GoogleSchema;
  required?: string[];
  enum?: string[];
}
interface GoogleRoute {
  pathParameters?: Record<string, GoogleParameter>;
  origin: string;
  path: string;
  method: string;
}
export interface GoogleOperation extends GoogleRoute {
  scopes: string[];
  query: Record<string, GoogleParameter>;
  requestSchema?: string;
}
interface Catalog {
  operations: Record<string, GoogleOperation>;
  reservedRoutes: GoogleRoute[];
  schemas: Record<string, GoogleSchema>;
}

// Only reviewed bytes from the bundled package can provide routes or request schemas. An
// account selection pins release.json, which in turn pins this potentially much larger file.
const directory = new URL(
  "../../../../plugins/oce-google-workspace/ai.openclaw.oce/",
  import.meta.url,
);
const releaseBytes = readFileSync(new URL("release.json", directory));
export const googleRelease = asRecord(JSON.parse(releaseBytes.toString("utf8")));
export const googleReleaseSha256 = createHash("sha256").update(releaseBytes).digest("hex");
const bytes = readFileSync(new URL("operations.json", directory));
if (createHash("sha256").update(bytes).digest("hex") !== googleRelease?.operationsSha256) {
  throw new Error("The Google Workspace operation catalog does not match the reviewed release.");
}
export const googleCatalog: Catalog = JSON.parse(bytes.toString("utf8"));

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compileRoute(rule: GoogleRoute, id?: string) {
  const parts = rule.path.split(/(\{\+?[A-Za-z0-9_]+\})/);
  const captures: (RegExp | undefined)[] = [];
  let supported = true;
  const regex = new RegExp(
    "^" +
      parts
        .map((part) => {
          if (!part.startsWith("{")) {
            return escape(part);
          }
          const expanded = part.startsWith("{+");
          const name = part.slice(expanded ? 2 : 1, -1);
          const parameter = rule.pathParameters?.[name];
          captures.push(
            parameter?.pattern ? new RegExp("^(?:" + parameter.pattern + ")$") : undefined,
          );
          if (expanded && !parameter?.pattern) {
            supported = false;
          }
          return expanded ? "([^:]+?)" : name === "range" ? "([^/]+)" : "([^/:]+)";
        })
        .join("") +
      "$",
  );
  return { rule, id, regex, captures, supported };
}

type Route = ReturnType<typeof compileRoute>;
const routes = new Map<string, Route[]>();
const addRoute = (route: Route) => {
  const key = route.rule.origin + " " + route.rule.method;
  const group = routes.get(key);
  if (group) {
    group.push(route);
  } else {
    routes.set(key, [route]);
  }
};
for (const [id, op] of Object.entries(googleCatalog.operations)) {
  addRoute(compileRoute(op, id));
}
for (const reserved of googleCatalog.reservedRoutes) {
  addRoute(compileRoute(reserved));
}

/** Prefer literal Google methods over parameterized routes, even when the literal is unavailable. */
export function googleRouteCandidates(origin: string, method: string, path: string) {
  const found: Route[] = [];
  const literal: Route[] = [];
  for (const route of routes.get(origin + " " + method) ?? []) {
    const matched = route.regex.exec(path);
    if (
      !matched ||
      route.captures.some((constraint, i) => constraint && !constraint.test(matched[i + 1]!))
    ) {
      continue;
    }
    if (route.captures.length === 0) {
      literal.push(route);
    } else {
      found.push(route);
    }
  }
  // A literal RPC takes precedence over an ID placeholder. When several parameterized
  // methods still match, require all of them to admit the request.
  return literal.length ? literal : found;
}

/** Support literal paths and OpenShell's canonical subtree glob. Other pattern languages
 * must be modeled before the plugin can select a source that uses them. */
export function googleSourcePathMatches(pattern: string, path: string) {
  if (!pattern.endsWith("/**")) {
    return pattern === path;
  }
  const prefix = pattern.slice(0, -3);
  return path === prefix || path.startsWith(prefix + "/");
}

export function eligibleGoogleOperations(scope: GoogleRequestScope) {
  const origin = "https://" + scope.host;
  return Object.entries(googleCatalog.operations).filter(([id, op]) => {
    if (op.origin !== origin || !op.scopes.some((s) => scope.scopes.includes(s))) {
      return false;
    }
    if (!scope.path.endsWith("/**")) {
      return googleRouteCandidates(origin, op.method, scope.path).some(
        (route) => route.id === id && route.supported,
      );
    }
    const prefix = scope.path.slice(0, -3);
    const staticPrefix = op.path.split("{")[0]!;
    return (
      staticPrefix.startsWith(prefix + "/") ||
      staticPrefix === prefix ||
      (op.path.includes("{") && prefix.startsWith(staticPrefix))
    );
  });
}

const releasedScopes = new Set(
  Object.values(googleCatalog.operations).flatMap((operation) => operation.scopes),
);

export function googleAccountScopeConfig(
  accounts: Readonly<Record<string, GoogleRequestScope>>,
): string {
  // Store each reviewed OAuth scope once. Independent sources often share the same long URLs;
  // scopes outside the release cannot authorize any of its operations.
  const grants = [
    ...new Set(
      Object.values(accounts).flatMap((account) =>
        account.scopes.filter((grant) => releasedScopes.has(grant)),
      ),
    ),
  ];
  const indices = new Map(grants.map((grant, index) => [grant, index]));
  return JSON.stringify({
    grants,
    accounts: Object.fromEntries(
      Object.entries(accounts).map(([id, account]) => [
        id,
        {
          ...account,
          scopes: account.scopes
            .filter((grant) => indices.has(grant))
            .map((grant) => indices.get(grant)),
        },
      ]),
    ),
  });
}

export function googleAccountScopes(raw: unknown): Record<string, GoogleRequestScope> | undefined {
  if (typeof raw !== "string" || !raw) {
    return undefined;
  }
  try {
    const config = asRecord(JSON.parse(raw));
    const accounts = asRecord(config?.accounts);
    const grants = config?.grants;
    if (
      !accounts ||
      !Object.keys(accounts).length ||
      !Array.isArray(grants) ||
      !grants.every((grant) => typeof grant === "string" && releasedScopes.has(grant))
    ) {
      return undefined;
    }
    const entries: [string, GoogleRequestScope][] = [];
    for (const [id, value] of Object.entries(accounts)) {
      const account = asRecord(value);
      if (
        !id ||
        !Array.isArray(account?.scopes) ||
        !account.scopes.every((i) => Number.isInteger(i) && i >= 0 && i < grants.length)
      ) {
        return undefined;
      }
      const scope = googleRequestScope({
        ...account,
        scopes: account.scopes.map((i) => grants[i]),
      });
      if (!scope) {
        return undefined;
      }
      entries.push([id, scope]);
    }
    return Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

export function googleRequestScope(input: unknown): GoogleRequestScope | undefined {
  const value = asRecord(input);
  if (
    !value ||
    Object.keys(value).length !== 4 ||
    value.port !== 443 ||
    typeof value.host !== "string" ||
    !/^[a-z0-9.-]+$/.test(value.host) ||
    typeof value.path !== "string" ||
    (!/^\/[A-Za-z0-9/._~-]*(?:\/\*\*)?$/.test(value.path) && value.path !== "/**") ||
    !Array.isArray(value.scopes) ||
    !value.scopes.length ||
    !value.scopes.every((s) => typeof s === "string" && /^[\x21-\x7e]+$/.test(s))
  ) {
    return undefined;
  }
  return { host: value.host, port: value.port, path: value.path, scopes: value.scopes };
}

/** gog lists the public directory and fetches an API description before a dynamic call.
 * The service-hosted fallback applies only to service/version pairs in this source's map.
 * Never offer a public request that the source's provider would credential. */
export function googleDiscoveryRequests(
  scope: GoogleRequestScope,
  entries = eligibleGoogleOperations(scope),
) {
  const root = "www.googleapis.com";
  const directory = "/discovery/v1/apis";
  const publicRequests = [
    { host: root, path: directory, query: "" },
    { host: root, path: directory, query: "preferred=true" },
  ];
  for (const api of new Set(entries.map(([id]) => id.split("/")[0]!))) {
    const [service, version] = api.split(":");
    if (!service || !version) {
      continue;
    }
    publicRequests.push(
      { host: root, path: directory + "/" + service + "/" + version + "/rest", query: "" },
      { host: service + ".googleapis.com", path: "/$discovery/rest", query: "version=" + version },
    );
  }
  return publicRequests.filter(
    ({ host, path }) => host !== scope.host || !googleSourcePathMatches(scope.path, path),
  );
}
