import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeConnectionDestinations } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";
import type { ConnectionEndpoint } from "@openclaw-enterprise/contracts";

export interface GoogleRequestScope {
  readonly destinations: readonly ConnectionEndpoint[];
  readonly scopes: readonly string[];
}

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

function serviceDestination(operation: GoogleOperation): ConnectionEndpoint {
  const root = operation.path.split("/")[1];
  if (!root || !/^[A-Za-z0-9_-]+$/.test(root)) {
    throw new Error("Google operation lacks a literal service path.");
  }
  return { host: new URL(operation.origin).hostname, port: 443, path: "/" + root + "/**" };
}

/** Service roots represented by the verified Google Workspace release, before account-specific grants. */
export const googleWorkspaceDestinations = normalizeConnectionDestinations(
  Object.values(googleCatalog.operations).map(serviceDestination),
);

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

function routeMatches(route: Route, path: string): boolean {
  const matched = route.regex.exec(path);
  return (
    !!matched &&
    route.captures.every((constraint, index) => !constraint || constraint.test(matched[index + 1]!))
  );
}

/** Prefer literal Google methods over parameterized routes, even when the literal is unavailable. */
export function googleRouteCandidates(origin: string, method: string, path: string) {
  const found: Route[] = [];
  const literal: Route[] = [];
  for (const route of routes.get(origin + " " + method) ?? []) {
    if (!routeMatches(route, path)) {
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

/** A sender may accept only reviewed HTTPS routes and literal paths or the canonical subtree glob. */
function isGoogleDestination(value: unknown): value is ConnectionEndpoint {
  const row = asRecord(value);
  return (
    !!row &&
    Object.keys(row).length === 3 &&
    row.port === 443 &&
    typeof row.host === "string" &&
    /^[a-z0-9.-]+$/.test(row.host) &&
    typeof row.path === "string" &&
    (row.path === "/**" || /^\/[A-Za-z0-9/._~-]*(?:\/\*\*)?$/.test(row.path)) &&
    !row.path.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

const catalogRoutes = Object.entries(googleCatalog.operations).map(([id, op]) => {
  const { host, path: servicePath } = serviceDestination(op);
  const prefixes: Route[] = [];
  // A narrower subtree can start below a path parameter (e.g. /users/me/messages/**).
  // Match the complete segment prefix using the same reviewed parameter constraints.
  const segments = op.path.split("/");
  for (let count = 2; count <= segments.length; count++) {
    prefixes.push(compileRoute({ ...op, path: segments.slice(0, count).join("/") }));
  }
  return { id, op, host, servicePath, prefixes };
});

function matchingRoutes(destinations: readonly ConnectionEndpoint[]) {
  return destinations.flatMap((row) => {
    if (!isGoogleDestination(row)) {
      return [];
    }
    // One exact path can represent different operations by method, including reserved routes.
    const exactByMethod = new Map<string, readonly Route[]>();
    return catalogRoutes.flatMap(({ id, op, host, servicePath, prefixes }) => {
      if (row.host !== host) {
        return [];
      }
      const subtree = row.path.endsWith("/**");
      const prefix = subtree ? row.path.slice(0, -3) : row.path;
      let rulePath: string;
      if (subtree && googleSourcePathMatches(row.path, op.path)) {
        rulePath = op.path;
      } else if (subtree) {
        const segment = prefixes.find((route) => route.supported && routeMatches(route, prefix));
        if (!segment) {
          return [];
        }
        rulePath = prefix + op.path.slice(segment.rule.path.length);
      } else {
        let candidates = exactByMethod.get(op.method);
        if (!candidates) {
          candidates = googleRouteCandidates(op.origin, op.method, row.path);
          exactByMethod.set(op.method, candidates);
        }
        if (!candidates.some((route) => route.id === id && route.supported)) {
          return [];
        }
        rulePath = row.path;
      }
      // Preserve the approved path when it is narrower than this API's service root.
      const path =
        subtree && googleSourcePathMatches(row.path, servicePath.slice(0, -3))
          ? servicePath
          : row.path;
      rulePath = rulePath.replace(/\{\+?\w+\}/g, "*");
      return [{ id, op, endpoint: { host, port: row.port, path }, rulePath }];
    });
  });
}

/** Admission is independent of which OAuth scopes the provider later grants. */
export function isGoogleWorkspaceRecipient(row: ConnectionEndpoint): boolean {
  return matchingRoutes([row]).length > 0;
}

/** Only scopes for reviewed operations at the approved destinations enter the request guard. */
export function googleWorkspaceDeliveryScopes(
  destinations: readonly ConnectionEndpoint[],
  grantedScopes: readonly string[],
): string[] {
  const supported = new Set(matchingRoutes(destinations).flatMap(({ op }) => op.scopes));
  return [...new Set(grantedScopes)].filter((scope) => supported.has(scope));
}

export function eligibleGoogleOperations(scope: GoogleRequestScope) {
  return matchingRoutes(scope.destinations).filter(({ op }) =>
    op.scopes.some((value) => scope.scopes.includes(value)),
  );
}

export function googleCredentialEndpoints(
  scope: GoogleRequestScope,
): readonly ConnectionEndpoint[] {
  const endpoints = new Map<string, ConnectionEndpoint>();
  for (const { endpoint } of eligibleGoogleOperations(scope)) {
    endpoints.set(endpoint.host + endpoint.path, endpoint);
  }
  return [...endpoints.values()];
}

export function googleScopeFromString(raw: unknown): GoogleRequestScope | undefined {
  if (typeof raw !== "string" || !raw) {
    return undefined;
  }
  try {
    return googleRequestScope(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function googleRequestScope(input: unknown): GoogleRequestScope | undefined {
  const value = asRecord(input);
  if (
    !value ||
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.destinations) ||
    !value.destinations.length ||
    !value.destinations.every(isGoogleDestination) ||
    !Array.isArray(value.scopes) ||
    !value.scopes.every((s) => typeof s === "string" && /^[\x21-\x7e]+$/.test(s))
  ) {
    return undefined;
  }
  return { destinations: value.destinations, scopes: value.scopes };
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
  for (const api of new Set(entries.map(({ id }) => id.split("/")[0]!))) {
    const [service, version] = api.split(":");
    if (!service || !version) {
      continue;
    }
    publicRequests.push(
      { host: root, path: directory + "/" + service + "/" + version + "/rest", query: "" },
      { host: service + ".googleapis.com", path: "/$discovery/rest", query: "version=" + version },
    );
  }
  const credentialed = scope.destinations;
  return publicRequests.filter(
    ({ host, path }) =>
      !credentialed.some((ep) => host === ep.host && googleSourcePathMatches(ep.path, path)),
  );
}
