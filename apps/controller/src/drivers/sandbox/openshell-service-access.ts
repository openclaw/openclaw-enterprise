import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { ConfigurationValidationError } from "@openclaw-enterprise/contracts";
import type {
  AgentRevision,
  ComputeServiceAccess,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy, publicCaBundle, sha256Hex } from "@openclaw-enterprise/utils";
import { publicGithubReadPolicy } from "../repo/github/public-read/access.ts";

export const PUBLIC_GITHUB_READ_SERVICE = "public-github-read";

function refuse(): never {
  throw new ConfigurationValidationError([
    {
      path: "/serviceAccess",
      code: "INVALID_VALUE",
      message: "OpenShell requires an exact supported public-reader service descriptor.",
    },
  ]);
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = asRecord(value);
  if (!record || !isDeepStrictEqual(Object.keys(record).sort(), [...keys].sort())) {
    refuse();
  }
  return record;
}

function dnsLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  );
}

function labelKey(value: string): boolean {
  const pieces = value.split("/");
  const name = pieces.at(-1)!;
  return (
    pieces.length <= 2 &&
    name.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/i.test(name) &&
    (pieces.length === 1 || (pieces[0]!.length <= 253 && pieces[0]!.split(".").every(dnsLabel)))
  );
}

function caBundle(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 65_536) {
    return false;
  }
  try {
    publicCaBundle(value);
    return true;
  } catch {
    return false;
  }
}

/** Both policy producers independently qualify the complete frozen, nonsecret descriptor. */
export function qualifyOpenShellServiceAccess(value: unknown): readonly ComputeServiceAccess[] {
  if (!Array.isArray(value) || value.length !== 1) {
    refuse();
  }
  const service = exact(value[0], [
    "id",
    "driverId",
    "implementation",
    "endpoint",
    "configuration",
  ]);
  if (
    service.id !== PUBLIC_GITHUB_READ_SERVICE ||
    typeof service.driverId !== "string" ||
    !service.driverId ||
    typeof service.implementation !== "string" ||
    !service.implementation ||
    typeof service.endpoint !== "string"
  ) {
    refuse();
  }
  let endpoint: URL;
  try {
    endpoint = new URL(service.endpoint);
  } catch {
    refuse();
  }
  const first = Number(endpoint.hostname.split(".")[0]);
  if (
    isIP(endpoint.hostname) !== 4 ||
    first === 0 ||
    first === 127 ||
    first >= 224 ||
    endpoint.hostname.startsWith("169.254.") ||
    service.endpoint !== `https://${endpoint.hostname}:8080`
  ) {
    refuse();
  }
  const configuration = exact(service.configuration, [
    "policy",
    "peer",
    "authorizationConfigMapName",
    "installationId",
    "caBundle",
  ]);
  let policy;
  try {
    policy = publicGithubReadPolicy(configuration.policy);
  } catch {
    refuse();
  }
  if (
    !isDeepStrictEqual(policy, configuration.policy) ||
    (policy.mode === "repositories" && policy.repositories.length === 0)
  ) {
    refuse();
  }
  const peer = exact(configuration.peer, ["namespace", "podLabels"]);
  const labels = asRecord(peer.podLabels);
  if (
    !dnsLabel(peer.namespace) ||
    !labels ||
    Object.keys(labels).length === 0 ||
    Object.keys(labels).length > 32 ||
    Object.entries(labels).some(
      ([key, value]) =>
        !labelKey(key) ||
        typeof value !== "string" ||
        value.length > 63 ||
        !/^(?:[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?)?$/i.test(value),
    ) ||
    typeof configuration.authorizationConfigMapName !== "string" ||
    configuration.authorizationConfigMapName.length > 253 ||
    !configuration.authorizationConfigMapName.split(".").every(dnsLabel) ||
    typeof configuration.installationId !== "string" ||
    !/^[a-z\d_-]{1,128}$/i.test(configuration.installationId) ||
    !caBundle(configuration.caBundle)
  ) {
    refuse();
  }
  return immutableCopy(value as ComputeServiceAccess[]);
}

export function openShellServiceNetworkRules(
  value: unknown,
): Readonly<OpenClawConfigurationDocument> {
  if (value === undefined) {
    return {};
  }
  const [service] = qualifyOpenShellServiceAccess(value);
  const host = new URL(service!.endpoint).hostname;
  return immutableCopy({
    [PUBLIC_GITHUB_READ_SERVICE]: {
      name: PUBLIC_GITHUB_READ_SERVICE,
      binaries: [
        "/usr/bin/node",
        "/usr/bin/git",
        "/usr/lib/git-core/git-remote-https",
        "/usr/lib/git-core/git-remote-http",
        "/usr/libexec/git-core/git-remote-https",
        "/usr/libexec/git-core/git-remote-http",
      ].map((path) => ({ path })),
      endpoints: [
        {
          host,
          ports: [8080],
          allowed_ips: [host],
          protocol: "rest",
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          rules: [
            { allow: { method: "GET", path: "/repos/**" } },
            { allow: { method: "GET", path: "/git/**/info/refs" } },
            { allow: { method: "POST", path: "/git/**/git-upload-pack" } },
          ],
        },
      ],
    },
  });
}

/** Validate persisted ownership before either paired Driver releases the service rule. */
export function openShellRevisionServiceRules(
  revision: Readonly<AgentRevision> | undefined,
): Readonly<OpenClawConfigurationDocument> {
  const services = revision?.sandboxPolicy?.serviceAccess;
  if (services === undefined) {
    return {};
  }
  qualifyOpenShellServiceAccess(services);
  if (
    revision?.harness.id !== "codex" ||
    revision.harness.mode !== "dedicated" ||
    !isDeepStrictEqual(revision.compute.serviceAccess, services) ||
    revision.sandboxPolicy?.implementation !== "openshell" ||
    revision.sandboxPolicy.driverId !== revision.sandboxDriverId ||
    services.some(
      (service) =>
        service.driverId !== revision.compute.id ||
        service.implementation !== revision.compute.implementation ||
        (revision.egressPlan !== undefined &&
          service.configuration.installationId !== revision.egressPlan.execution.installationId),
    )
  ) {
    refuse();
  }
  const rules = openShellServiceNetworkRules(services);
  return immutableCopy(
    Object.fromEntries(
      Object.entries(rules).map(([name, value]) => {
        const rule = value as { endpoints: readonly Readonly<Record<string, unknown>>[] };
        return [
          name,
          {
            ...rule,
            endpoints: rule.endpoints.map((endpoint) => ({
              ...endpoint,
              credential_binding: { provider: `oce-runtime-${sha256Hex(revision.id, 16)}` },
            })),
          },
        ];
      }),
    ),
  );
}
