import { Type } from "typebox";
import { Check } from "typebox/value";
import { ConfigurationValidationError, requireConfiguration } from "./configuration-definition.ts";
import { validRepositoryGitRecipient } from "./drivers/credential-proxy/index.ts";
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

// Only destination spelling is a wire property. Operator admission owns the HTTP mirror
// and shared-object exceptions; the provider must check resolved peers on each connection.
const dnsLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const nonPublicSuffix =
  "arpa|internal|local|localdomain[46]?|localhost|lan|home|corp|intranet|private|svc|onion|test|invalid|example|alt";
// A segment is literal in both a URL and a path matcher. Refuse escapes, empty
// segments and standalone dot segments before a URL parser can normalize them.
const downloadPath = Type.String({
  maxLength: 2048,
  pattern: "^(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9._~+:@-]+)+(?![\\s\\S])",
});
const destinationFields = {
  host: Type.String({
    format: "hostname",
    maxLength: 253,
    pattern: `^(?!.*\\.(?:${nonPublicSuffix})$)(?:${dnsLabel}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,58}[a-z0-9])(?![\\s\\S])`,
  }),
  path: Type.Optional(downloadPath),
};

export const ProtectedDownloadDestinationSchema = Type.Union([
  Type.Object(
    { scheme: Type.Literal("https"), port: Type.Literal(443), ...destinationFields },
    { additionalProperties: false },
  ),
  Type.Object(
    { scheme: Type.Literal("http"), port: Type.Literal(80), ...destinationFields },
    { additionalProperties: false },
  ),
]);
export type ProtectedDownloadDestination = Type.Static<typeof ProtectedDownloadDestinationSchema>;
export const ProtectedDownloadDestinationsSchema = Type.Array(ProtectedDownloadDestinationSchema, {
  maxItems: 32,
  uniqueItems: true,
});
export function validProtectedDownloadDestinations(
  value: unknown,
): value is ProtectedDownloadDestination[] {
  return Check(ProtectedDownloadDestinationsSchema, value);
}

const downloadHosts = Type.Array(destinationFields.host, { uniqueItems: true });

export const ProtectedDownloadLimitsSchema = Type.Object(
  {
    executablePaths: Type.Array(
      Type.String({
        maxLength: 512,
        pattern: "^(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9_+.@-]+)+(?![\\s\\S])",
      }),
      { minItems: 1, uniqueItems: true },
    ),
    reservedHosts: Type.Optional(downloadHosts),
    httpMirrors: Type.Optional(downloadHosts),
    sharedArchiveHosts: Type.Optional(downloadHosts),
    sharedArchiveObjects: Type.Optional(
      Type.Array(
        Type.Object(
          {
            scheme: Type.Literal("https"),
            port: Type.Literal(443),
            host: destinationFields.host,
            path: downloadPath,
          },
          { additionalProperties: false },
        ),
        { uniqueItems: true },
      ),
    ),
    delegatedDestinations: Type.Optional(
      Type.Array(ProtectedDownloadDestinationSchema, { uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);
export type ProtectedDownloadLimits = Type.Static<typeof ProtectedDownloadLimitsSchema>;

export function protectedDownloadDestinationWithinLimits(
  limits: ProtectedDownloadLimits,
  destination: ProtectedDownloadDestination,
): boolean {
  return (
    Check(ProtectedDownloadDestinationSchema, destination) &&
    !limits.reservedHosts?.includes(destination.host) &&
    (destination.scheme === "https" || limits.httpMirrors?.includes(destination.host) === true) &&
    (!limits.sharedArchiveHosts?.includes(destination.host) ||
      (destination.scheme === "https" &&
        limits.sharedArchiveObjects?.some(
          (object) => object.host === destination.host && object.path === destination.path,
        ) === true))
  );
}

/** Caller supplies current, exact credential hostnames and the executable selected by the pair. */
export function protectedDownloadDestinationAllowed(
  limits: ProtectedDownloadLimits | undefined,
  destination: ProtectedDownloadDestination,
  provider:
    | { readonly executablePath: string; readonly reservedCredentialHosts: readonly string[] }
    | undefined,
): boolean {
  return (
    limits !== undefined &&
    provider !== undefined &&
    limits.executablePaths.includes(provider.executablePath) &&
    protectedDownloadDestinationWithinLimits(limits, destination) &&
    !provider.reservedCredentialHosts.some(
      (host) => host.toLowerCase().replace(/\.$/, "") === destination.host,
    )
  );
}

const protectedDownloadInstallationSchema = Type.Object({
  protectedDownloads: ProtectedDownloadLimitsSchema,
});

export function parseProtectedDownloadLimits(value: unknown): ProtectedDownloadLimits {
  return requireConfiguration(
    {
      configurationSchema: { ...protectedDownloadInstallationSchema },
      validateConfiguration({
        protectedDownloads: limits,
      }: Type.Static<typeof protectedDownloadInstallationSchema>) {
        const details: ErrorDetail[] = [];
        for (const key of ["httpMirrors", "sharedArchiveHosts"] as const) {
          limits[key]?.forEach((host, index) => {
            if (
              limits.reservedHosts?.includes(host) ||
              (key === "httpMirrors" && limits.sharedArchiveHosts?.includes(host))
            ) {
              details.push({
                path: `/protectedDownloads/${key}/${index}`,
                code: "INVALID_VALUE",
                message: "Host classifications must be disjoint.",
              });
            }
          });
        }
        limits.sharedArchiveObjects?.forEach((object, index) => {
          if (!limits.sharedArchiveHosts?.includes(object.host)) {
            details.push({
              path: `/protectedDownloads/sharedArchiveObjects/${index}/host`,
              code: "INVALID_VALUE",
              message: "Declare the shared archive host before allowing an object.",
            });
          }
        });
        limits.delegatedDestinations?.forEach((destination, index) => {
          if (!protectedDownloadDestinationWithinLimits(limits, destination)) {
            details.push({
              path: `/protectedDownloads/delegatedDestinations/${index}`,
              code: "INVALID_VALUE",
              message: "Delegated destination conflicts with the Installation download limits.",
            });
          }
        });
        return details;
      },
    },
    { protectedDownloads: value },
  ).protectedDownloads;
}

/** The defaults are an opaque, nonsecret Driver snapshot. OCC never interprets provider syntax. */
export interface SandboxPolicySnapshot {
  readonly driverId: string;
  readonly implementation: string;
  readonly version: number;
  readonly defaults: Readonly<OpenClawConfigurationDocument>;
  readonly additions: readonly SandboxNetworkGrant[];
}

/** Explicit, nonsecret acknowledgement; only its validated snapshot is persisted. */
export interface ProtectedCodexArtifactPolicyAdmission {
  readonly purpose: "protected-codex-artifacts";
  readonly declaredRuleNames: readonly string[];
  readonly snapshot: SandboxPolicySnapshot;
}

interface ApplicationIdentity {
  readonly id: string;
  readonly revisionId: string;
  readonly policyVersion: number;
  readonly state: "pending" | "applied" | "failed";
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly providerVersion?: string;
  readonly reason?: string;
}

const closed = { additionalProperties: false };
const identifier = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9._:-]+(?![\\s\\S])",
});
const operationId = Type.String({ format: "uuid" });
const timestamp = Type.String({ format: "date-time", maxLength: 40 });
const version = Type.Integer({ minimum: 1, maximum: 0xffffffff });
const hash = Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" });
const repositoryGitRecipient = Type.Object(
  {
    providerId: identifier,
    attachmentEpoch: identifier,
    processInstanceId: identifier,
    networkInstanceId: identifier,
    deliveryProfile: Type.Optional(
      Type.Union([Type.Literal("github_installation"), Type.Literal("github_repository")]),
    ),
    authorization: Type.Optional(
      Type.Union([Type.Literal("online-request"), Type.Literal("request-hook-observed")]),
    ),
    observedHook: Type.Optional(
      Type.Object(
        { startupId: Type.String({ format: "uuid", maxLength: 36 }), observationId: hash },
        closed,
      ),
    ),
  },
  closed,
);
const fence = Type.Object(
  {
    sandboxId: identifier,
    instanceId: identifier,
    configurationId: identifier,
    peer: Type.Union([
      Type.Object({ keyId: identifier }, closed),
      Type.Object({ repositoryGitRecipient }, closed),
    ]),
    installationLimitsHash: hash,
    providerResourceVersion: identifier,
    policyVersion: version,
    sourcePolicyHash: hash,
    effectivePolicyHash: hash,
  },
  closed,
);
const protectedApplication = Type.Object(
  {
    kind: Type.Literal("protected_downloads"),
    id: operationId,
    revisionId: identifier,
    policyVersion: version,
    state: Type.Union([Type.Literal("pending"), Type.Literal("applied"), Type.Literal("failed")]),
    requestedBy: Type.String({ minLength: 1, maxLength: 512 }),
    requestedAt: timestamp,
    providerVersion: Type.Optional(identifier),
    reason: Type.Optional(Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}(?![\\s\\S])" })),
    action: Type.Union([
      Type.Literal("approve-and-enable"),
      Type.Literal("enable"),
      Type.Literal("disable"),
      Type.Literal("withdraw-approval"),
    ]),
    destination: ProtectedDownloadDestinationSchema,
    desiredSourcePolicyHash: hash,
    priorDesiredDownloadDestinations: ProtectedDownloadDestinationsSchema,
    priorApprovedDownloadDestinations: ProtectedDownloadDestinationsSchema,
    previousDownloadDestinations: ProtectedDownloadDestinationsSchema,
    desiredDownloadDestinations: ProtectedDownloadDestinationsSchema,
    expected: fence,
    writeState: Type.Union([Type.Literal("prepared"), Type.Literal("dispatched")]),
    acknowledgedWrite: Type.Optional(
      Type.Object(
        {
          state: Type.Literal("committed"),
          sandboxId: identifier,
          operationId,
          policyVersion: version,
          sourcePolicyHash: hash,
        },
        closed,
      ),
    ),
  },
  closed,
);

type Fence = import("./drivers/credential-proxy/index.ts").ProtectedDownloadPolicyFence;
type Write = import("./drivers/credential-proxy/index.ts").ProtectedDownloadPolicyWrite;

export function validProtectedDownloadPolicyFence(value: unknown): value is Fence {
  if (!Check(fence, value)) {
    return false;
  }
  if ("keyId" in value.peer) {
    return true;
  }
  const recipient = value.peer.repositoryGitRecipient;
  return validRepositoryGitRecipient(
    recipient,
    recipient.deliveryProfile ?? "repository_git",
    recipient.authorization,
  );
}

export type SandboxPolicyApplication = ApplicationIdentity &
  (
    | {
        readonly kind?: never;
        readonly snapshot: SandboxPolicySnapshot;
        readonly expectedProviderVersion?: string;
      }
    | {
        readonly kind: "protected_downloads";
        readonly expectedProviderVersion?: never;
        readonly action: Type.Static<typeof protectedApplication>["action"];
        readonly destination: ProtectedDownloadDestination;
        readonly desiredSourcePolicyHash: string;
        readonly priorDesiredDownloadDestinations: readonly ProtectedDownloadDestination[];
        readonly priorApprovedDownloadDestinations: readonly ProtectedDownloadDestination[];
        readonly previousDownloadDestinations: readonly ProtectedDownloadDestination[];
        readonly desiredDownloadDestinations: readonly ProtectedDownloadDestination[];
        readonly expected: Fence;
        readonly writeState: "prepared" | "dispatched";
        readonly acknowledgedWrite?: Write;
      }
  );

export function validProtectedDownloadApplication(value: unknown): boolean {
  return Check(protectedApplication, value) && validProtectedDownloadPolicyFence(value.expected);
}

const protectedReceipt = Type.Object(
  {
    kind: Type.Literal("protected_downloads"),
    operationId,
    revisionId: identifier,
    policyVersion: version,
    providerVersion: identifier,
    appliedAt: timestamp,
    confirmedDownloadDestinations: ProtectedDownloadDestinationsSchema,
    fence,
  },
  closed,
);
export function validProtectedDownloadReceipt(value: unknown): boolean {
  return Check(protectedReceipt, value) && validProtectedDownloadPolicyFence(value.fence);
}

export interface SandboxPolicy {
  readonly id: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly version: number;
  readonly additions: readonly SandboxNetworkGrant[];
  readonly approvedDownloadDestinations?: readonly ProtectedDownloadDestination[];
  readonly downloadDestinations?: readonly ProtectedDownloadDestination[];
  readonly application?: SandboxPolicyApplication;
  readonly applied?: {
    readonly revisionId: string;
    readonly policyVersion: number;
    readonly providerVersion: string;
    readonly appliedAt: string;
  } & (
    | { readonly kind?: never }
    | {
        readonly kind: "protected_downloads";
        readonly operationId: string;
        readonly confirmedDownloadDestinations: readonly ProtectedDownloadDestination[];
        readonly fence: Fence;
      }
  );
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
    // An empty or reversed range names no port, so it can never prove containment.
    if (grant.ports.length === 0 || grant.ports.some(({ from, to }) => from > to)) {
      return false;
    }
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
