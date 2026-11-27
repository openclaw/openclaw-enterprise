import type {
  DeploymentCredentialBinding,
  DeploymentPolicy,
  DeploymentRequestMatch,
  DriverRegistrationRef,
  HarnessAuthSnapshot,
  SandboxNetworkGrant,
  SandboxPolicySnapshot,
} from "../../packages/contracts/src/index.ts";

type DriverIdentity = Pick<DriverRegistrationRef, "id" | "implementation">;

export function stagedCredentialOwner<Sandbox extends DriverIdentity, Proxy>(
  sandbox: Sandbox,
  proxy: Proxy,
) {
  const { id, implementation } = sandbox;
  return {
    ref: { id, implementation, configurationId: "a".repeat(64) },
    require(capability: "sandbox" | "credential_proxy_delivery") {
      return capability === "sandbox" ? sandbox : proxy;
    },
  };
}

export function stagedSandboxPolicy(
  { id: driverId, implementation }: DriverIdentity,
  additions: SandboxPolicySnapshot["additions"],
): SandboxPolicySnapshot {
  return { driverId, implementation, version: 1, defaults: {}, additions };
}

export function stagedCredentialDeployment(
  proxyDriverId: string,
  driver: DriverRegistrationRef,
  policy: DeploymentPolicy,
) {
  return { proxyDriverId, driver, ...policy };
}

export function stagedOpenAiModel(namespaceId: string) {
  const auth = {
    method: "credential_source",
    sourceId: "cs_staged_model",
    tokenServiceInstanceId: "tokens",
    sourceType: "static",
  } satisfies HarnessAuthSnapshot;
  const network = {
    binary: "/usr/local/bin/node",
    host: "api.openai.com",
    ports: [{ from: 443, to: 443 }],
  };
  const grant = { id: "model-egress", ...network } satisfies SandboxNetworkGrant;
  const request = {
    ...network,
    requestPolicy: { type: "http", method: "POST", path: "/v1/responses" },
  } satisfies DeploymentRequestMatch;
  const binding = {
    bindingRef: "model",
    sourceRef: { kind: "credential_source", namespaceId, id: auth.sourceId },
    consumer: { kind: "model", providerId: "openai" },
    projection: { environment: "OPENAI_API_KEY", presentation: "bearer" },
  } satisfies DeploymentCredentialBinding;
  return { auth, grant, network, request, binding };
}
