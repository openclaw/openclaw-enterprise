import { isDeepStrictEqual } from "node:util";
import { asRecord, immutableCopy, numericLastLabel, sha256Hex } from "@openclaw-enterprise/utils";
import { validateSandboxNetworkGrants } from "@openclaw-enterprise/contracts";
import type { SandboxNetworkGrant, SandboxPolicySnapshot } from "@openclaw-enterprise/contracts";

export const AGENT_POLICY_PREFIX = "oce-agent-";

/** Unknown native selectors or numeric destinations cannot be proved disjoint. */
function openShellHostMayOverlap(candidate: string, host: string): boolean {
  const selector = candidate.toLowerCase().replace(/\.$/, "");
  const target = host.toLowerCase().replace(/\.$/, "");
  const wildcard = /^\*{1,2}\.[a-z0-9.-]+$/.test(selector);
  return (
    (!wildcard && !/^[a-z0-9.-]+$/.test(selector)) ||
    numericLastLabel(selector) ||
    selector === target ||
    (wildcard && target.endsWith(selector.slice(selector.indexOf("."))))
  );
}

/** OpenShell allowances compose, so another route must be provably disjoint. */
export function openShellNetworkRouteMayOverlap(
  policies: unknown,
  target: { readonly host: string; readonly port: number },
  exactRoutes: readonly string[] = [],
): boolean {
  const network = asRecord(policies);
  if (!network) {
    return true;
  }
  for (const [name, value] of Object.entries(network)) {
    if (exactRoutes.includes(name)) {
      continue;
    }
    const rule = asRecord(value);
    if (!rule) {
      return true;
    }
    const endpoints = rule.endpoints;
    if (endpoints === undefined) {
      continue;
    }
    if (!Array.isArray(endpoints)) {
      return true;
    }
    for (const value of endpoints) {
      const endpoint = asRecord(value);
      if (typeof endpoint?.host !== "string") {
        return true;
      }
      const ports =
        Array.isArray(endpoint.ports) && endpoint.ports.length
          ? endpoint.ports
          : typeof endpoint.port === "number" && endpoint.port > 0
            ? [endpoint.port]
            : [target.port];
      if (ports.includes(target.port) && openShellHostMayOverlap(endpoint.host, target.host)) {
        return true;
      }
    }
  }
  return false;
}

export function openShellAgentNetworkRules(additions: readonly SandboxNetworkGrant[]) {
  validateSandboxNetworkGrants(additions);
  return Object.fromEntries(
    additions.map((grant) => {
      const ports = [
        ...new Set(
          grant.ports.flatMap(({ from, to }) => {
            if (to - from > 1023) {
              throw new Error("OpenShell grants support at most 1024 ports.");
            }
            return Array.from({ length: to - from + 1 }, (_, i) => from + i);
          }),
        ),
      ];
      if (ports.length > 1024) {
        throw new Error("OpenShell grants support at most 1024 ports.");
      }
      const name = `${AGENT_POLICY_PREFIX}${grant.id}`;
      return [
        name,
        {
          name,
          binaries: [{ path: grant.binary }],
          endpoints: [
            {
              host: grant.host,
              ports,
              tls: "NETWORK_TLS_MODE_SKIP",
              enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
            },
          ],
        },
      ];
    }),
  );
}

/** Ignore protobuf default values; preserve every non-default field and array element. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  const record = asRecord(value);
  if (record === undefined) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key, field]) =>
          // Optional scalar markers name an actual field. Policy map keys remain significant.
          !(key.startsWith("_") && field === key.slice(1) && Object.hasOwn(record, field)) &&
          // grpc-js adds this discriminator to google.protobuf.Value in middleware config.
          !(
            key === "kind" &&
            typeof field === "string" &&
            /^(null|number|string|bool|struct|list)Value$/.test(field) &&
            Object.hasOwn(record, field)
          ) &&
          field !== undefined &&
          field !== null &&
          field !== "" &&
          field !== 0 &&
          // Unset strict_tool_names defaults to true, so explicit false changes enforcement.
          (field !== false || key === "strict_tool_names") &&
          !(Array.isArray(field) && field.length === 0) &&
          !(asRecord(field) !== undefined && Object.keys(field as object).length === 0),
      )
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, field]) => [key, canonical(field)]),
  );
}

export function sameOpenShellPolicy(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(canonical(left), canonical(right));
}

/** Bind the admitted policy while letting live applications replace Agent grants. */
export function openShellPolicyBaselineDigest(policy: Readonly<Record<string, unknown>>): string {
  const network = asRecord(policy.network_policies) ?? {};
  const baseline = canonical({
    ...policy,
    network_policies: Object.fromEntries(
      Object.entries(network).filter(([name]) => !name.startsWith(AGENT_POLICY_PREFIX)),
    ),
  });
  return sha256Hex(JSON.stringify(baseline));
}

/** The create-time policy carries static restrictions and generated workspace access. */
export function openShellPolicyCandidate(
  baseline: Readonly<Record<string, unknown>>,
  snapshot: SandboxPolicySnapshot,
) {
  const network = asRecord(baseline.network_policies);
  if (network === undefined) {
    throw new Error("Missing Sandbox baseline policy.");
  }
  const defaults = asRecord(snapshot.defaults);
  if (defaults === undefined) {
    throw new Error("Invalid policy snapshot.");
  }
  const baseRules = Object.fromEntries(
    Object.entries(network).filter(([name]) => !name.startsWith(AGENT_POLICY_PREFIX)),
  );
  for (const [name, rule] of Object.entries(defaults)) {
    if (!sameOpenShellPolicy(baseRules[name], rule)) {
      throw new Error("Sandbox defaults differ from the admitted revision.");
    }
  }
  return immutableCopy({
    ...baseline,
    network_policies: { ...baseRules, ...openShellAgentNetworkRules(snapshot.additions) },
  });
}
