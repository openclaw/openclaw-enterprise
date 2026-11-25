import type {
  ConfigurationContribution,
  CredentialProxyDriver,
  DriverRegistration,
} from "@openclaw-enterprise/contracts";

const contracts = ["complete", "missing-method", "foreign-identity", "raw-no-cleanup"] as const;

export const configurationSchema = {
  type: "object",
  additionalProperties: false,
  properties: { contract: { enum: contracts } },
};

export function validateConfiguration() {
  return [];
}

export const configurationContributions = [
  {
    scope: "agent",
    key: "sandbox-network-policy",
    configurationSchema: { type: "object", additionalProperties: false },
    validateConfiguration,
  },
] satisfies readonly ConfigurationContribution[];

export const observations = { namespaces: [] as string[], closed: 0 };

export function createDriver({
  id,
  implementation,
  configuration,
}: {
  id: string;
  implementation: string;
  configuration: { contract?: (typeof contracts)[number] };
}): DriverRegistration {
  const malformedRaw = configuration.contract === "raw-no-cleanup";
  function unavailable(): never {
    throw new Error("This package fixture has no running Harness or credential material.");
  }
  const delivery = {
    id: configuration.contract === "foreign-identity" ? "foreign" : id,
    implementation,
    capability: "credential_proxy_delivery",
    deployProxy: unavailable,
    configureDeployment: unavailable,
    getDeploymentStatus: unavailable,
    removeDeployment: unavailable,
  } satisfies CredentialProxyDriver;
  if (configuration.contract === "missing-method") {
    // An installed package can advertise a contract it does not actually implement.
    Reflect.deleteProperty(delivery, "getDeploymentStatus");
  }
  return {
    ...(malformedRaw && { id, implementation, capability: "sandbox" }),
    capabilities: {
      sandbox: {
        id,
        implementation,
        capability: "sandbox",
        facets: ["networking"],
        supportsHarnessExecutionMode: Object.freeze({
          openclaw: Object.freeze({
            embedded: Object.freeze({ supported: false }),
            dedicated: Object.freeze({ supported: true }),
          }),
        }),
        networkPolicy: { wildcards: false, portRanges: false, live: true },
        cleanup: unavailable,
        provisionHarness: unavailable,
        provisionStagedHarness: unavailable,
        prepareStagedHarness: unavailable,
        activateStagedHarness: unavailable,
        admitNetworkPolicy: unavailable,
        observeNetworkPolicy: unavailable,
        applyNetworkPolicy: unavailable,
        harnessStatus: unavailable,
      },
      credential_proxy_delivery: delivery,
    },
    namespaceLifecycleHooks: {
      async ensureNamespace({ namespace }) {
        observations.namespaces.push(namespace.id);
        return { namespaceId: namespace.id, namespaceReady: true };
      },
    },
    close() {
      observations.closed++;
      if (malformedRaw) {
        throw new Error("Raw Sandbox close failed.");
      }
    },
  };
}
