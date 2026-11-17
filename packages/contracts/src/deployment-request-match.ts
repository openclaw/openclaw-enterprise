import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ErrorDetail } from "./api/common.ts";
import type { DeploymentRequestMatch, DeploymentRequestPolicy } from "./credential-deployment.ts";
import { networkMatchDetails, SandboxNetworkGrantSchema } from "./sandbox-policy.ts";

type Destination = Pick<DeploymentRequestMatch, "host" | "ports">;
type PortRanges = DeploymentRequestMatch["ports"];

const strict = { additionalProperties: false } as const;
const literal = Type.String({ minLength: 1, pattern: "^[^\\s\\x00-\\x1f\\x7f*?]+$" });
const path = Type.String({ pattern: "^/[^\\s\\x00-\\x1f\\x7f?#*\\\\]*$" });
const requestSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal("http"),
      path,
      method: Type.String({ pattern: "^[A-Za-z0-9!#$%&'\\+.^_`|~-]+$" }),
    },
    strict,
  ),
  Type.Object(
    {
      type: Type.Literal("mcp"),
      path,
      method: literal,
      toolName: Type.Optional(literal),
    },
    strict,
  ),
  Type.Object({ type: Type.Literal("evaluator"), id: literal, digest: literal }, strict),
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

function sameRequest(a?: DeploymentRequestPolicy, b?: DeploymentRequestPolicy): boolean {
  if (!a || !b) {
    return a === b;
  }
  switch (a.type) {
    case "http":
      return b.type === "http" && a.path === b.path && a.method === b.method;
    case "mcp":
      return (
        b.type === "mcp" && a.path === b.path && a.method === b.method && a.toolName === b.toolName
      );
    case "evaluator":
      return b.type === "evaluator" && a.id === b.id && a.digest === b.digest;
  }
}

export function requestCovered(
  match: DeploymentRequestMatch,
  allowed: readonly DeploymentRequestMatch[],
): boolean {
  const candidates = allowed.filter(
    (limit) =>
      match.binary === limit.binary &&
      hostCovered(match.host, limit.host) &&
      (limit.requestPolicy === undefined || sameRequest(match.requestPolicy, limit.requestPolicy)),
  );
  return portsCovered(match.ports, candidates);
}

function destinationsOverlap(a: Destination, b: Destination): boolean {
  return (
    (hostCovered(a.host, b.host) || hostCovered(b.host, a.host)) &&
    a.ports.some((x) => b.ports.some((y) => x.from <= y.to && y.from <= x.to))
  );
}

// Two exact methods or tool names can be alternatives. An opaque evaluator has no
// provable intersection semantics with any other selector.
export function disjointRequests(
  a?: DeploymentRequestPolicy,
  b?: DeploymentRequestPolicy,
): boolean {
  if (!a || !b || a.type === "evaluator" || b.type === "evaluator") {
    return false;
  }
  return a.path !== b.path || (a.type === b.type && !sameRequest(a, b));
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
    if (
      policy &&
      policy.type !== "evaluator" &&
      policy.path.split("/").some((part) => part === "." || part === "..")
    ) {
      details.push({
        path,
        code: "INVALID_VALUE",
        message: "Use an exact request path without dot segments.",
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
    if (
      matches
        .slice(0, index)
        .some(
          (other) =>
            grant.binary === other.binary &&
            destinationsOverlap(grant, other) &&
            !sameRequest(grant.requestPolicy, other.requestPolicy) &&
            !disjointRequests(grant.requestPolicy, other.requestPolicy),
        )
    ) {
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
