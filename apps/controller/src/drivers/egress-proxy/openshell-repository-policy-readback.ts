import { isDeepStrictEqual } from "node:util";
import { asRecord } from "@openclaw-enterprise/utils";
import {
  openShellProfileEndpoint,
  type OpenShellGatewayClient,
  type OpenShellProviderProfile,
} from "../sandbox/openshell-gateway-client.ts";
import type { OpenShellPreparedGitInstalled } from "./openshell-prepared-git-provider.ts";
import { withOpenShellProviderTokenGrantOwners } from "./openshell-token-grant-owner.ts";
import { wirePolicy } from "./openshell-wire-policy.ts";

/** Expected composition of an OCE-owned profile, before it is attached to a Sandbox. */
export function openShellExpectedProviderRule(
  name: string,
  profile: Pick<OpenShellProviderProfile, "binaries" | "credentials" | "endpoints">,
  providerId?: string,
) {
  return {
    name,
    ...(providerId === undefined ? {} : { providerId }),
    rule: {
      name: "_provider_" + name.replaceAll("-", "_"),
      binaries: profile.binaries.map((path) => ({ path })),
      endpoints: profile.endpoints.map((endpoint) => ({
        ...openShellProfileEndpoint(endpoint),
        ...(profile.credentials.length > 0 && { provider_credentialed: true }),
      })),
    },
  };
}

export type OpenShellExpectedProviderRule = ReturnType<typeof openShellExpectedProviderRule>;
type GitRule = OpenShellExpectedProviderRule["rule"];

// Stock OpenShell can relay SQL in audit mode without inspecting the stream.
const inspectedProtocols = new Set(["rest", "websocket", "graphql", "json-rpc", "mcp"]);

/** An ambiguous destination or opaque relay could route around the exact Git rule. */
function hasOnlyInspectedNonGitEndpoints(rule: unknown, gitRule: GitRule): boolean {
  const policy = asRecord(rule);
  if (!policy) {
    return false;
  }
  const endpoints = policy.endpoints ?? [];
  return (
    Array.isArray(endpoints) &&
    endpoints.every((value) => {
      const endpoint = asRecord(value);
      const host = endpoint?.host;
      return (
        endpoint !== undefined &&
        typeof host === "string" &&
        /^[a-z0-9-]+(?:[.][a-z0-9-]+)*[.][a-z][a-z0-9-]*$/i.test(host) &&
        !/(?:^|[.])github[.]com$/i.test(host) &&
        gitRule.endpoints.every((git) => git.host.toLowerCase() !== host.toLowerCase()) &&
        typeof endpoint.protocol === "string" &&
        inspectedProtocols.has(endpoint.protocol) &&
        (endpoint.tls === undefined || endpoint.tls === "NETWORK_TLS_MODE_UNSPECIFIED") &&
        (endpoint.allowed_ips === undefined ||
          (Array.isArray(endpoint.allowed_ips) && endpoint.allowed_ips.length === 0))
      );
    })
  );
}

function matchesPolicy(
  source: Record<string, unknown>,
  effective: Record<string, unknown>,
  gitRule: GitRule,
  gitProviderId: string,
  expectedProviders: readonly OpenShellExpectedProviderRule[],
): boolean {
  const { network_policies: authored, ...staticSource } = source;
  const { network_policies: applied, ...staticEffective } = effective;
  const sourceRules = authored === undefined ? {} : asRecord(authored);
  const effectiveRules = asRecord(applied);
  if (
    !sourceRules ||
    !effectiveRules ||
    Object.keys(sourceRules).some((name) => name.startsWith("_provider_")) ||
    !isDeepStrictEqual(wirePolicy(staticSource), wirePolicy(staticEffective))
  ) {
    return false;
  }
  const stampedGitRule = withOpenShellProviderTokenGrantOwners(gitRule, gitProviderId);
  if (!stampedGitRule) {
    return false;
  }
  const providerRules = { [gitRule.name]: stampedGitRule };
  for (const { name, rule, providerId } of expectedProviders) {
    if (
      rule.name !== "_provider_" + name.replaceAll("-", "_") ||
      Object.hasOwn(providerRules, rule.name)
    ) {
      return false;
    }
    const stampedRule = withOpenShellProviderTokenGrantOwners(rule, providerId);
    if (!stampedRule) {
      return false;
    }
    providerRules[rule.name] = stampedRule;
  }
  return (
    isDeepStrictEqual(
      wirePolicy({ network_policies: { ...sourceRules, ...providerRules } }),
      wirePolicy({ network_policies: effectiveRules }),
    ) &&
    Object.entries(effectiveRules).every(
      ([name, rule]) => name === gitRule.name || hasOnlyInspectedNonGitEndpoints(rule, gitRule),
    )
  );
}

/** Stock reports a source version and the desired effective policy separately. Join both
 * to the exact active supervisor generation observed by the Provider caller. */
export async function verifyOpenShellRepositoryPolicy(
  client: OpenShellGatewayClient,
  installed: OpenShellPreparedGitInstalled,
  gitRule: GitRule,
  expectedProviders: readonly OpenShellExpectedProviderRule[] | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  if (!expectedProviders || !client.getSandboxPolicyStatus || !client.getSandboxConfig) {
    return false;
  }
  const { workspace, sandbox, sandboxId, attachmentEpoch, policyHash } = installed;
  const [status, config] = await Promise.all([
    client.getSandboxPolicyStatus(workspace, sandbox, signal),
    client.getSandboxConfig(workspace, sandbox, signal),
  ]);
  const revision = asRecord(status.revision);
  const source = asRecord(revision?.policy);
  const effective = asRecord(config.policy);
  const version = revision?.version;
  if (
    !source ||
    !effective ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version <= 0 ||
    revision?.status !== "POLICY_STATUS_LOADED" ||
    revision.load_error ||
    status.active_version !== version ||
    config.version !== version ||
    config.workspace !== workspace ||
    config.policy_source !== 1 ||
    (config.global_policy_version !== undefined && config.global_policy_version !== 0) ||
    config.configuration_admitted !== true ||
    config.configuration_error ||
    config.policy_validation_failure_mode !== "fail_closed" ||
    config.provider_attachment_epoch !== attachmentEpoch ||
    config.policy_hash !== policyHash ||
    config.config_revision !== installed.configRevision ||
    config.provider_env_revision !== installed.providerEnvRevision ||
    !matchesPolicy(source, effective, gitRule, installed.providerId, expectedProviders)
  ) {
    return false;
  }
  // Resolve the name again after the reads. A replacement must not inherit this observation.
  const box = await client.getSandbox({ workspace, name: sandbox }, signal);
  const admission = box?.configurationAdmission;
  // The Sandbox Driver verifies this spec against the admitted AgentRevision. The
  // two live policy reads can agree after a policy update that changed that baseline.
  const admittedPolicy = asRecord(box?.spec?.policy);
  const providers = box?.spec?.providers;
  const expectedNames = new Set([installed.provider, ...expectedProviders.map(({ name }) => name)]);
  return (
    !signal.aborted &&
    admittedPolicy !== undefined &&
    isDeepStrictEqual(wirePolicy(source), wirePolicy(admittedPolicy)) &&
    box?.id === sandboxId &&
    box.name === sandbox &&
    box.workspace === workspace &&
    box.mainProcessInstanceId === installed.networkInstanceId &&
    box.spec?.provider_attachment_epoch === attachmentEpoch &&
    Array.isArray(providers) &&
    providers.length === expectedNames.size &&
    new Set(providers).size === expectedNames.size &&
    providers.every((name: unknown) => typeof name === "string" && expectedNames.has(name)) &&
    admission?.state === 2 &&
    typeof admission.instance_id === "string" &&
    admission.instance_id.length > 0 &&
    admission.instance_id === config.configuration_instance_id &&
    admission.policy_version === version &&
    admission.policy_hash === policyHash &&
    admission.config_revision === installed.configRevision &&
    admission.provider_env_revision === installed.providerEnvRevision &&
    !admission.error
  );
}
