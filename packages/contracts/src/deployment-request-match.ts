import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ErrorDetail } from "./api/common.ts";
import type { DeploymentRequestMatch, DeploymentRequestPolicy } from "./credential-deployment.ts";
import { networkMatchDetails, SandboxNetworkGrantSchema } from "./sandbox-policy.ts";

type Destination = Pick<DeploymentRequestMatch, "host" | "ports">;
type PortRanges = DeploymentRequestMatch["ports"];

const strict = { additionalProperties: false } as const;
const literal = Type.String({ minLength: 1, pattern: "^[^\\s\\x00-\\x1f\\x7f*?]+$" });
const requestSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("http"),
      path: Type.String(),
      method: Type.String({ pattern: "^[A-Za-z0-9!#$%&'\\+.^_`|~-]+$" }),
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("mcp"),
      path: Type.String(),
      method: literal,
      toolName: Type.Optional(literal),
    },
    strict,
  ),
]);

const { binary, host, ports } = SandboxNetworkGrantSchema.properties;
const matchSchema = Type.Object(
  {
    binary,
    host,
    ports,
    requestPolicy: Type.Optional(requestSchema),
  },
  strict,
);

export function hostCovered(host: string, ceiling: string): boolean {
  if (host === ceiling) {
    return true;
  }
  if (!ceiling.startsWith("*.") || host.startsWith("*.")) {
    return false;
  }
  const suffix = ceiling.slice(1);
  const label = host.slice(0, -suffix.length);
  return host.endsWith(suffix) && label.length > 0 && !label.includes(".");
}

export function portsCovered(ports: PortRanges, allowed: readonly Destination[]): boolean {
  if (!ports.length || ports.some(({ from, to }) => from > to)) {
    return false;
  }
  const ranges = allowed.flatMap((entry) => entry.ports).sort((a, b) => a.from - b.from);
  return ports.every(({ from, to }) => {
    let next = from;
    for (const range of ranges) {
      if (range.from > next) {
        break;
      }
      next = Math.max(next, range.to + 1);
      if (next > to) {
        return true;
      }
    }
    return false;
  });
}

// Compare paths in their wire form. A space is always %20. Other escapes can
// change segment boundaries or acquire a different meaning after decoding.
function validPath(path: unknown, allowSubtree: boolean): path is string {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("//")) {
    return false;
  }
  const base = allowSubtree && path.endsWith("/**") ? path.slice(0, -3) : path;
  return (
    /^(?:[A-Za-z0-9._~!$&'()+,:=@/-]|%20)*$/.test(base) &&
    !base.split("/").some((part) => part === "." || part === "..")
  );
}

/** A terminal subtree includes its base and descendants separated by a slash. */
export function pathCovered(path: string, allowedPath: string): boolean {
  if (!validPath(path, true) || !validPath(allowedPath, true)) {
    return false;
  }
  if (path === allowedPath) {
    return true;
  }
  if (!allowedPath.endsWith("/**")) {
    return false;
  }
  const base = allowedPath.slice(0, -3);
  return path === base || path.startsWith(base + "/");
}

function sameRequest(a?: DeploymentRequestPolicy, b?: DeploymentRequestPolicy): boolean {
  return (
    a?.type === b?.type &&
    a?.method === b?.method &&
    a?.path === b?.path &&
    (a?.type !== "mcp" || (b?.type === "mcp" && a.toolName === b.toolName))
  );
}

export function requestPolicyCovered(
  policy?: DeploymentRequestPolicy,
  allowed?: DeploymentRequestPolicy,
): boolean {
  if (allowed === undefined) {
    return true;
  }
  if (allowed.type === "http" && policy?.type === "http") {
    return policy.method === allowed.method && pathCovered(policy.path, allowed.path);
  }
  return sameRequest(policy, allowed);
}

export function requestCovered(
  match: DeploymentRequestMatch,
  allowed: readonly DeploymentRequestMatch[],
): boolean {
  const candidates = allowed.filter(
    (limit) =>
      match.binary === limit.binary &&
      hostCovered(match.host, limit.host) &&
      requestPolicyCovered(match.requestPolicy, limit.requestPolicy),
  );
  return portsCovered(match.ports, candidates);
}

function destinationsOverlap(a: Destination, b: Destination): boolean {
  return (
    (hostCovered(a.host, b.host) || hostCovered(b.host, a.host)) &&
    a.ports.some((x) => b.ports.some((y) => x.from <= y.to && y.from <= x.to))
  );
}

export function disjointRequests(
  a?: DeploymentRequestPolicy,
  b?: DeploymentRequestPolicy,
): boolean {
  if (!a || !b) {
    return false;
  }
  if (!pathCovered(a.path, b.path) && !pathCovered(b.path, a.path)) {
    return true;
  }
  // The contract distinguishes HTTP from MCP operations. Different selectors on the
  // same endpoint do not establish that the enforcing Driver can separate the requests.
  return (
    (a.type === "http" && b.type === "http" && a.method !== b.method) ||
    (a.type === "mcp" && b.type === "mcp" && !sameRequest(a, b))
  );
}

function conflictingAllowances(a: DeploymentRequestMatch, b: DeploymentRequestMatch): boolean {
  const left = a.requestPolicy;
  const right = b.requestPolicy;
  if (
    a.binary !== b.binary ||
    !destinationsOverlap(a, b) ||
    sameRequest(left, right) ||
    disjointRequests(left, right)
  ) {
    return false;
  }
  // A nested HTTP allowance adds no access if the wider rule also covers its host and ports.
  if (left?.type === "http" && right?.type === "http") {
    return !requestCovered(a, [b]) && !requestCovered(b, [a]);
  }
  return true;
}

export function validateMatches(
  matches: readonly DeploymentRequestMatch[],
  pointer: string,
): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  matches.forEach((rule, index) => {
    const path = `${pointer}/${index}`;
    if (!Check(matchSchema, rule)) {
      details.push({
        path,
        code: "INVALID_VALUE",
        message: "Use a complete, supported request match.",
      });
      return;
    }
    details.push(...networkMatchDetails(rule, path));
    const policy = rule.requestPolicy;
    if (policy && !validPath(policy.path, policy.type === "http")) {
      details.push({
        path,
        code: "INVALID_VALUE",
        message: "Use a canonical request path. Only HTTP paths can end in a subtree wildcard.",
      });
    }
    if (
      policy?.type === "mcp" &&
      (policy.method === "tools/call") !== (policy.toolName !== undefined)
    ) {
      details.push({
        path,
        code: "INVALID_VALUE",
        message: "Specify an exact tool name for tools/call only.",
      });
    }
  });
  if (details.length) {
    return details;
  }
  matches.forEach((grant, index) => {
    if (matches.slice(0, index).some((other) => conflictingAllowances(grant, other))) {
      details.push({
        path: `${pointer}/${index}`,
        code: "INVALID_VALUE",
        message: "Overlapping allowances would weaken a request restriction.",
      });
    }
  });
  return details;
}

export function intersectPorts(a: PortRanges, b: PortRanges): PortRanges {
  return a.flatMap((x) =>
    b.flatMap((y) => {
      const from = Math.max(x.from, y.from);
      const to = Math.min(x.to, y.to);
      return from <= to ? [{ from, to }] : [];
    }),
  );
}
