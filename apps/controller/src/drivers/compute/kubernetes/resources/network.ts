/** Explicit classification for controller-approved workload templates. Label
 * writers and NetworkPolicy enforcement remain separate trust boundaries.
 *
 * This module is the single home for network profile constants. Compute-owned
 * workloads carry the ordinary profile. Harness Pods provisioned by a
 * SandboxDriver carry the provider-fenced profile: they receive Compute's
 * ingress grants (Gateway transport and plugin status) and only the exact
 * workspace-node enrollment egress grant. The provider owns every other egress
 * decision. */
export const NETWORK_PROFILE_LABEL = "openclaw.dev/network-profile";
export const ORDINARY_NETWORK_PROFILE = "broad-egress-v1";
export const PROVIDER_FENCED_NETWORK_PROFILE = "provider-fenced-v1";
export type NetworkProfile =
  typeof ORDINARY_NETWORK_PROFILE | typeof PROVIDER_FENCED_NETWORK_PROFILE;

/** Grants require their exact profile. Scope labels cannot override it. */
export function profileNetworkPolicySelector(
  profile: NetworkProfile,
  matchLabels: Readonly<Record<string, string>> = {},
): {
  matchLabels: Record<string, string>;
} {
  return { matchLabels: { ...matchLabels, [NETWORK_PROFILE_LABEL]: profile } };
}

/** Ordinary grants require their exact profile. Scope labels cannot override it. */
export function ordinaryNetworkPolicySelector(matchLabels: Readonly<Record<string, string>> = {}): {
  matchLabels: Record<string, string>;
} {
  return profileNetworkPolicySelector(ORDINARY_NETWORK_PROFILE, matchLabels);
}

/** The same selector without the profile, as written before explicit profiles.
 * Only for keeping a serving pre-profile workload's grant until it is replaced. */
export function withoutNetworkProfile(selector: Readonly<Record<string, unknown>> | undefined): {
  matchLabels: Record<string, string>;
} {
  const labels = selector?.matchLabels;
  const matchLabels: Record<string, string> = {};
  if (typeof labels === "object" && labels !== null) {
    for (const [name, value] of Object.entries(labels)) {
      if (name !== NETWORK_PROFILE_LABEL && typeof value === "string") {
        matchLabels[name] = value;
      }
    }
  }
  return { matchLabels };
}
