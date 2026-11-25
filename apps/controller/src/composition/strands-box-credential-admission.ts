import { SOURCE_PROVIDER_PRESET_CONFIG_KEY } from "@openclaw-enterprise/contracts";
import { ResourceStateConflictError, type ControllerOptions } from "@openclaw-enterprise/occ";

import { kubernetesNamespaceName } from "../drivers/compute/kubernetes/index.ts";
import { StrandsBoxCredentialProxyDriver } from "../drivers/credential-proxy/strands-box.ts";
import { StrandsBoxSandboxDriver } from "../drivers/sandbox/strands-box.ts";
import {
  STOCK_RESPONSES_MATCH,
  supportsStockPolicy,
} from "../drivers/sandbox/strands-box-model.ts";

/** The installation grant is additional to deployer and Agent Source authorization. */
export const strandsBoxAgentModelGrant: NonNullable<ControllerOptions["agentModelGrant"]> = ({
  agent,
  sandbox,
  source,
  harness,
}) => {
  const grant =
    sandbox instanceof StrandsBoxSandboxDriver ? sandbox.agentResponsesGrant : undefined;
  if (!grant) {
    return undefined;
  }
  if (
    grant.namespace !== kubernetesNamespaceName(agent.namespaceId) ||
    grant.agentId !== agent.id ||
    agent.harnessAuth?.method !== "credential_source" ||
    agent.harnessAuth.sourceId !== grant.sourceId ||
    agent.repositoryAccess !== undefined ||
    Object.keys(agent.plugins ?? {}).length !== 0 ||
    agent.networkProxy !== undefined ||
    agent.credentialSources?.some(({ sourceId }) => sourceId !== grant.sourceId) ||
    source?.id !== grant.sourceId ||
    source.namespaceId !== agent.namespaceId ||
    source.state !== "ready" ||
    source.type !== "static" ||
    source.connectionTemplateId !== undefined ||
    source.config[SOURCE_PROVIDER_PRESET_CONFIG_KEY] !== "openai" ||
    harness.id !== "codex" ||
    harness.mode !== "dedicated"
  ) {
    throw new ResourceStateConflictError(
      "Staged Strands Box requires the configured Agent and its approved OpenAI Source on a dedicated Codex Harness without other consumers.",
    );
  }
  return STOCK_RESPONSES_MATCH;
};

export const supportsStrandsBoxCredentialDeployment: NonNullable<
  ControllerOptions["supportsCredentialDeployment"]
> = ({ sandbox, proxy, policy }) => {
  if (
    !(sandbox instanceof StrandsBoxSandboxDriver) ||
    !(proxy instanceof StrandsBoxCredentialProxyDriver)
  ) {
    return false;
  }
  const grant = sandbox.agentResponsesGrant;
  const source = policy.bindings[0]?.sourceRef;
  return (
    grant !== undefined &&
    sandbox.id === proxy.id &&
    source?.id === grant.sourceId &&
    kubernetesNamespaceName(source.namespaceId) === grant.namespace &&
    supportsStockPolicy(policy)
  );
};
