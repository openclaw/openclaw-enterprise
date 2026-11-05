import { isDeepStrictEqual } from "node:util";
import { asRecord, immutableCopy } from "@openclaw-enterprise/utils";
import { validateSandboxNetworkGrants } from "@openclaw-enterprise/contracts";
import type { SandboxNetworkGrant, SandboxPolicySnapshot } from "@openclaw-enterprise/contracts";

export const AGENT_POLICY_PREFIX = "oce-agent-";

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
          !key.startsWith("_") &&
          field !== undefined &&
          field !== null &&
          field !== "" &&
          field !== 0 &&
          field !== false &&
          !(Array.isArray(field) && field.length === 0) &&
          !(asRecord(field) !== undefined && Object.keys(field as object).length === 0),
      )
      .map(([key, field]) => [key, canonical(field)]),
  );
}

export function sameOpenShellPolicy(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(canonical(left), canonical(right));
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
