import { Type } from "typebox";
import { Check } from "typebox/value";
import { ConfigurationValidationError, requireConfiguration } from "./configuration-definition.ts";
import type { ErrorDetail } from "./api/common.ts";
import type { OpenClawConfigurationDocument } from "./index.ts";

export const SandboxNetworkGrantSchema = Type.Object(
  {
    id: Type.String({ title: "Rule ID", pattern: "^[a-z][a-z0-9-]{0,47}$" }),
    binary: Type.String({
      title: "Executable path",
      description: "Absolute path of the executable receiving access.",
      minLength: 2,
      maxLength: 512,
      pattern: "^/[^\\s\\x00-\\x1f]+$",
    }),
    host: Type.String({
      title: "Destination hostname",
      description:
        "DNS hostname or permitted single-label wildcard. Grants allow access; omitted destinations stay denied.",
      minLength: 1,
      maxLength: 253,
      pattern: "^(\\*\\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$",
    }),
    ports: Type.Array(
      Type.Object(
        {
          from: Type.Integer({ title: "Start port", minimum: 1, maximum: 65535 }),
          to: Type.Integer({ title: "End port", minimum: 1, maximum: 65535 }),
        },
        { additionalProperties: false },
      ),
      { title: "Port ranges", minItems: 1, maxItems: 16 },
    ),
  },
  { additionalProperties: false },
);

export const SandboxNetworkGrantsSchema = Type.Array(SandboxNetworkGrantSchema, {
  title: "Network rules",
  maxItems: 32,
});
export type SandboxNetworkGrant = Type.Static<typeof SandboxNetworkGrantSchema>;

/** The defaults are an opaque, nonsecret Driver snapshot. OCC never interprets provider syntax. */
export interface SandboxPolicySnapshot {
  readonly driverId: string;
  readonly implementation: string;
  readonly version: number;
  readonly defaults: Readonly<OpenClawConfigurationDocument>;
  readonly additions: readonly SandboxNetworkGrant[];
}

export interface SandboxPolicyApplication {
  readonly id: string;
  readonly revisionId: string;
  readonly policyVersion: number;
  readonly snapshot: SandboxPolicySnapshot;
  readonly state: "pending" | "applied" | "failed";
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly expectedProviderVersion?: string;
  readonly providerVersion?: string;
  readonly reason?: string;
}

export interface SandboxPolicy {
  readonly id: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly version: number;
  readonly additions: readonly SandboxNetworkGrant[];
  readonly application?: SandboxPolicyApplication;
  readonly applied?: {
    readonly revisionId: string;
    readonly policyVersion: number;
    readonly providerVersion: string;
    readonly appliedAt: string;
  };
}

export interface SandboxPolicyObservation {
  readonly resourceVersion: string;
  readonly policyVersion: string;
  readonly state: "pending" | "applied" | "failed";
  /** True only when the provider's complete desired policy equals the admitted snapshot. */
  readonly matches: boolean;
}

export interface SandboxPolicyRecommendation {
  readonly id: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly grant: SandboxNetworkGrant;
  readonly rationale?: string;
  readonly observations?: number;
}

export interface SandboxPolicyRecommendations {
  /** Advisory snapshot version; aggregate counts may change without advancing it. */
  readonly providerVersion?: string;
  readonly recommendations: readonly SandboxPolicyRecommendation[];
  readonly truncated: boolean;
}

/** Validate all destinations in each grant; sampling a wildcard or range cannot prove containment. */
export function validateSandboxNetworkGrants(
  value: unknown,
  inputPath = "/additions",
): asserts value is readonly SandboxNetworkGrant[] {
  try {
    requireConfiguration(SandboxNetworkPolicyConfiguration, { additions: value });
  } catch (error) {
    if (!(error instanceof ConfigurationValidationError) || inputPath === "/additions") {
      throw error;
    }
    // The owning caller supplies its grant-array pointer; the shared Agent definition
    // still validates additions, but its wrapper is not part of that caller's input.
    throw new ConfigurationValidationError(
      error.error.details.map((detail) => ({
        ...detail,
        path: `${inputPath}${detail.path.slice("/additions".length)}`,
      })) as [ErrorDetail, ...ErrorDetail[]],
    );
  }
}

const NetworkPolicyConfigurationSchema = Type.Object(
  { additions: SandboxNetworkGrantsSchema },
  { additionalProperties: false },
);

export const SandboxNetworkPolicyConfiguration = Object.freeze({
  scope: "agent" as const,
  key: "sandbox-network-policy",
  configurationSchema: { ...NetworkPolicyConfigurationSchema },
  validateConfiguration({
    additions,
  }: Readonly<Type.Static<typeof NetworkPolicyConfigurationSchema>>): readonly ErrorDetail[] {
    const details: ErrorDetail[] = [];
    const ids = new Set<string>();
    additions.forEach((grant, index) => {
      const path = `/additions/${index}`;
      if (ids.has(grant.id)) {
        details.push({
          path: `${path}/id`,
          code: "INVALID_VALUE",
          message: "Grant IDs must be unique.",
        });
      }
      ids.add(grant.id);
      if (
        grant.binary
          .split("/")
          .some((part, i) => i > 0 && (part === "" || part === "." || part === ".."))
      ) {
        details.push({
          path: `${path}/binary`,
          code: "INVALID_VALUE",
          message: "Use a normalized absolute executable path.",
        });
      }
      if (
        grant.host
          .replace(/^\*\./, "")
          .split(".")
          .some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
      ) {
        details.push({
          path: `${path}/host`,
          code: "INVALID_VALUE",
          message: "Use a valid DNS host or single-label wildcard.",
        });
      }
      grant.ports.forEach(({ from, to }, port) => {
        if (from > to) {
          details.push({
            path: `${path}/ports/${port}/to`,
            code: "INVALID_RANGE",
            message: "The end port must be at least the start port.",
          });
        }
      });
    });
    return details;
  },
});

function hostCovered(host: string, ceiling: string): boolean {
  if (host === ceiling) {
    return true;
  }
  if (!ceiling.startsWith("*.")) {
    return false;
  }
  const suffix = ceiling.slice(1);
  return (
    !host.startsWith("*.") &&
    host.endsWith(suffix) &&
    !host.slice(0, -suffix.length).includes(".") &&
    host.length > suffix.length
  );
}

export function sandboxNetworkGrantsWithinCeiling(
  grants: readonly SandboxNetworkGrant[],
  ceiling: readonly SandboxNetworkGrant[],
): boolean {
  return grants.every((grant) => {
    const ranges = ceiling
      .filter((limit) => limit.binary === grant.binary && hostCovered(grant.host, limit.host))
      .flatMap(({ ports }) => ports)
      .sort((a, b) => a.from - b.from);
    return grant.ports.every(({ from, to }) => {
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
  });
}

export const SandboxPolicyDecisionSchema = Type.Object(
  {
    decision: Type.Union([Type.Literal("denied"), Type.Literal("allowed")]),
    enforcement: Type.Union([Type.Literal("blocked"), Type.Literal("reported")]),
    binary: Type.Optional(Type.String({ maxLength: 512 })),
    host: Type.Optional(Type.String({ maxLength: 512 })),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    reason: Type.Optional(Type.String({ maxLength: 512 })),
    rule: Type.Optional(Type.String({ maxLength: 512 })),
    engine: Type.Optional(Type.String({ maxLength: 512 })),
    policyGeneration: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { additionalProperties: false },
);
export type SandboxPolicyDecision = Type.Static<typeof SandboxPolicyDecisionSchema>;

export function validSandboxPolicyDecision(value: unknown): value is SandboxPolicyDecision {
  return Check(SandboxPolicyDecisionSchema, value);
}
